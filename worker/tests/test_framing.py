"""Enquadramento pelo rosto: decisão estável, recorte central como reserva e integração com o FFmpeg."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.framing import DetectorUnavailable, Face, YuNetDetector, analyze, choose_framing, crop_fraction, offset_for
from cca_worker.render import RenderSpec, RenderStage, output_name, output_plan, video_filter
from cca_worker.runner import JobRunner, run_loop

from tests.fake_app import FakeApp
from tests.test_render import HAS_FFMPEG, approved, ff, gray_frame, probe

FRAC = crop_fraction(1280, 720)  # janela 9:16 ocupa 31,6% da largura de um vídeo 16:9
MODEL = load_settings().face_model


def face(cx: float, h: float = 0.4, w: float | None = None, score: float = 0.9) -> Face:
    w = h * 0.5625 if w is None else w
    return Face(cx - w / 2, 0.1, w, h, score)


def window(offset: float) -> tuple[float, float]:
    left = offset * (1 - FRAC)
    return left, left + FRAC


class DecisionTests(unittest.TestCase):
    def test_centered_face_keeps_the_center(self):
        d = choose_framing([[face(0.51)] for _ in range(10)], FRAC)
        self.assertEqual((d.mode, d.offset), ("face", 0.5))
        self.assertIn("já centralizado", d.note)

    def test_off_center_face_gets_a_fixed_window_around_it(self):
        frames = [[face(0.2 + (0.01 if i % 2 else -0.01))] for i in range(12)]  # pequenas oscilações
        d = choose_framing(frames, FRAC)
        self.assertEqual(d.mode, "face")
        left, right = window(d.offset)
        self.assertLess(left, 0.2 - 0.12)
        self.assertGreater(right, 0.2 + 0.12, "o rosto e a área em volta (ombros) ficam na janela")
        self.assertAlmostEqual((left + right) / 2, 0.2, delta=0.02)

    def test_face_near_the_edge_is_limited_to_the_video(self):
        d = choose_framing([[face(0.9, h=0.4, w=0.15)] for _ in range(8)], FRAC)
        self.assertEqual(d.offset, 1.0)
        self.assertEqual(offset_for(-0.5, FRAC), 0.0)

    def test_no_face_or_few_frames_with_face_fall_back_to_center(self):
        self.assertEqual(choose_framing([[] for _ in range(10)], FRAC).mode, "center")
        rare = [[face(0.2)] if i < 5 else [] for i in range(10)]
        d = choose_framing(rare, FRAC)
        self.assertEqual((d.mode, d.offset), ("center", 0.5))
        self.assertIn("5 de 10", d.note)

    def test_small_background_faces_are_ignored(self):
        d = choose_framing([[face(0.15, h=0.03)] for _ in range(10)], FRAC)
        self.assertEqual(d.mode, "center")

    def test_multiple_faces_that_fit_are_framed_together(self):
        frames = [[face(0.18, h=0.4, w=0.1), face(0.32, h=0.4, w=0.1)] for _ in range(10)]
        d = choose_framing(frames, FRAC)
        left, right = window(d.offset)
        for f in frames[0]:
            self.assertGreaterEqual(f.x, left - 0.001)
            self.assertLessEqual(f.x + f.w, right + 0.001)
        self.assertIn("rostos em cena", d.note)

    def test_multiple_faces_far_apart_use_the_main_one_and_suggest_blur(self):
        frames = [[face(0.2, h=0.45), face(0.8, h=0.35)] for _ in range(10)]
        d = choose_framing(frames, FRAC)
        self.assertEqual(d.mode, "face")
        self.assertAlmostEqual(sum(window(d.offset)) / 2, 0.2, delta=0.02, msg="o maior rosto é o principal")
        self.assertIn("Fundo desfocado", d.note)

    def test_moving_face_falls_back_to_center_instead_of_following(self):
        frames = [[face(0.2)] if i % 2 else [face(0.8)] for i in range(10)]
        d = choose_framing(frames, FRAC)
        self.assertEqual((d.mode, d.offset), ("center", 0.5))
        self.assertIn("muda de posição", d.note)
        # Um rosto que sai da janela em 2 de 15 quadros (ex.: câmera que troca de lado) também não serve.
        frames = [[face(0.18)] for _ in range(13)] + [[face(0.82)] for _ in range(2)]
        self.assertEqual(choose_framing(frames, FRAC).mode, "center")

    def test_small_face_uses_blur_so_nothing_is_hidden(self):
        # Câmera no canto de uma gravação de tela: rosto com 25% da altura (medido num vídeo real).
        d = choose_framing([[face(0.18, h=0.25)] for _ in range(12)], FRAC)
        self.assertEqual(d.mode, "blur")
        self.assertIn("Fundo desfocado", d.note)
        # Pessoa falando para a câmera (rosto com ~50% da altura) continua no modo rosto.
        self.assertEqual(choose_framing([[face(0.3, h=0.5)] for _ in range(12)], FRAC).mode, "face")

    def test_vertical_video_has_nothing_to_choose(self):
        self.assertEqual(crop_fraction(720, 1280), 1.0)
        self.assertEqual(choose_framing([[face(0.2)]], 1.0).mode, "center")

    def test_filter_and_file_name_use_the_fixed_position(self):
        self.assertIn("crop=1080:1920:x=(iw-ow)*0.2500:y=(ih-oh)/2", video_filter("face", False, 0.25))
        self.assertIn("x=(iw-ow)*1.0000", video_filter("face", False, 7))  # limitado
        self.assertNotIn("x=", video_filter("crop", False, 0.25), "o recorte central não muda")
        fp = {"file": "s.mp4", "sizeBytes": 1, "mtimeNs": 1}
        spec = RenderSpec("c1", 0, 5, "face", "none")
        self.assertNotEqual(output_name(spec, fp, 0.25), output_name(spec, fp, 0.5))
        self.assertEqual(output_name(RenderSpec("c1", 0, 5, "crop", "none"), fp, 0.25), output_name(RenderSpec("c1", 0, 5, "crop", "none"), fp))


class OutputPlanTests(unittest.TestCase):
    # Os mesmos exemplos estão em tests/render.test.ts (renderQuality).
    def test_low_resolution_sources_get_a_smaller_output(self):
        cases = [
            (640, 360, "crop", (720, 1280), 3.56),
            (640, 360, "face", (720, 1280), 3.56),
            (640, 360, "blur", (1080, 1920), 1.69),
            (854, 480, "crop", (720, 1280), 2.67),
            (1280, 720, "crop", (1080, 1920), 2.67),
            (1920, 1080, "crop", (1080, 1920), 1.78),
            (1920, 1080, "blur", (1080, 1920), 0.56),
            (1080, 1920, "crop", (1080, 1920), 1.0),
            (720, 1280, "blur", (1080, 1920), 1.5),
        ]
        for w, h, framing, size, upscale in cases:
            plan = output_plan(w, h, framing)
            self.assertEqual((plan.width, plan.height), size, (w, h, framing))
            self.assertAlmostEqual(plan.upscale, upscale, delta=0.01, msg=(w, h, framing))
        self.assertIn("não são recuperados", output_plan(640, 360, "crop").note)
        self.assertEqual(output_plan(1920, 1080, "crop").note, "", "fonte boa: sem aviso")
        self.assertEqual((output_plan(None, None, "crop").width, output_plan(0, 0, "blur").upscale), (1080, None))

    def test_filters_use_the_planned_size(self):
        self.assertIn("crop=720:1280", video_filter("crop", False, size=(720, 1280)))
        self.assertIn("scale=720:1280:force_original_aspect_ratio=decrease", video_filter("blur", True, size=(720, 1280)))
        with self.assertRaises(Exception):
            video_filter("crop", False, size=(333, 444))


class FakeDetector:
    def __init__(self, faces=None, error: Exception | None = None):
        self.faces = faces or []
        self.error = error
        self.calls = 0

    def detect(self, frame):
        self.calls += 1
        if self.error:
            raise self.error
        return list(self.faces)


@unittest.skipUnless(HAS_FFMPEG, "FFmpeg/ffprobe não instalados")
class AnalyzeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="cca-framing-"))
        cls.video = left_marked_source(cls.tmp / "left.mp4")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_detector_failure_falls_back_to_center(self):
        for error in (RuntimeError("onnx quebrou"), DetectorUnavailable("modelo ausente"), MemoryError()):
            d = analyze(FakeDetector(error=error), "ffmpeg", self.video, 1.0, 6.0, 1280, 720)
            self.assertEqual((d.mode, d.offset), ("center", 0.5), repr(error))
            self.assertIn("recorte central", d.note)

    def test_missing_model_falls_back_to_center(self):
        d = analyze(YuNetDetector(self.tmp / "nao-existe.onnx"), "ffmpeg", self.video, 1.0, 6.0, 1280, 720)
        self.assertEqual(d.mode, "center")
        self.assertIn("indisponível", d.note)

    def test_unreadable_video_falls_back_to_center(self):
        d = analyze(FakeDetector([face(0.2)]), "ffmpeg", self.tmp / "sumiu.mp4", 1.0, 6.0, 1280, 720)
        self.assertEqual(d.mode, "center")

    def test_frames_are_sampled_across_the_clip(self):
        detector = FakeDetector([face(0.125, h=0.4)])
        d = analyze(detector, "ffmpeg", self.video, 0.5, 6.0, 1280, 720)
        self.assertEqual(detector.calls, 6, "6 quadros num corte curto, numa passada só")
        self.assertEqual(d.offset, 0.0)

    @unittest.skipUnless(MODEL.is_file(), "modelo YuNet não baixado")
    def test_real_yunet_finds_no_face_in_a_test_pattern(self):
        d = analyze(YuNetDetector(MODEL), "ffmpeg", self.video, 0.5, 6.0, 1280, 720)
        self.assertEqual(d.mode, "center")
        self.assertIn("0 de 6", d.note)


def left_marked_source(path: Path) -> Path:
    """Vídeo 1280×720 preto com uma faixa branca à esquerda (x < 320)."""
    ff("-v", "error", "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=30:duration=8,drawbox=x=0:y=0:w=320:h=720:t=fill:c=white",
       "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-shortest", "-y", str(path))  # fmt: skip
    return path


@unittest.skipUnless(HAS_FFMPEG, "FFmpeg/ffprobe não instalados")
class FaceRenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assets = Path(tempfile.mkdtemp(prefix="cca-face-assets-"))
        cls.left = left_marked_source(cls.assets / "left.mp4")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.assets, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-face-test-"))
        self.app = FakeApp().__enter__()
        self.settings = load_settings(self.tmp, environ={"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "CCA_RENDER_PRESET": "ultrafast"})
        self.api = WorkerApi(self.app.url, self.app.token)

    def tearDown(self):
        self.app.__exit__()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def render(self, detector, framing="face") -> tuple[Path, dict]:
        media = self.tmp / ".data" / "media" / "p_face"
        media.mkdir(parents=True)
        video = media / "source-abc.mp4"
        shutil.copy(self.left, video)
        original = video.read_bytes()
        self.app.add("p_face", "rendering", f"media/p_face/{video.name}", str(video), duration=8.0)
        self.app.projects["p_face"]["clips"] = [approved("c1", 1.0, 7.0, framing, "none")]
        outcomes = run_loop(JobRunner(self.settings, self.api, None, None, RenderStage(self.settings, self.api, detector)), once=True)
        self.assertEqual([o.result for o in outcomes], ["completed"])
        self.assertEqual(video.read_bytes(), original, "o vídeo original não muda")
        render = self.app.projects["p_face"]["clips"][0]["render"]
        self.assertEqual(render["state"], "done", render.get("error"))
        return media / render["file"], render

    def brightness(self, path: Path) -> float:
        frame = gray_frame(path, 2.0)
        return sum(frame) / len(frame)

    def test_face_on_the_left_moves_the_window_without_zoom(self):
        out, render = self.render(FakeDetector([face(0.125, h=0.4)]))
        video = next(s for s in probe(out)["streams"] if s["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (1080, 1920), "mesma escala do recorte central: sem zoom")
        self.assertGreater(self.brightness(out), 150, "a janela foi para a esquerda, onde está a faixa branca")
        self.assertIn("posição fixa", render["framingNote"])

    def test_detector_failure_still_renders_with_center_crop(self):
        out, render = self.render(FakeDetector(error=RuntimeError("falha simulada")))
        self.assertLess(self.brightness(out), 20, "recorte central: só a área preta")
        self.assertIn("recorte central", render["framingNote"])

    def test_no_face_renders_like_the_center_crop(self):
        face_out, _ = self.render(FakeDetector([]))
        self.assertLess(self.brightness(face_out), 20)

    def test_small_face_renders_the_whole_image_over_blur(self):
        out, render = self.render(FakeDetector([face(0.125, h=0.25)]))
        frame = gray_frame(out, 2.0)
        w, h = 108, 192
        middle = frame[(h // 2) * w : (h // 2 + 1) * w]
        # Imagem inteira encaixada na largura: a faixa branca (x < 25%) aparece à esquerda e o resto é preto.
        self.assertGreater(sum(middle[:20]) / 20, 150)
        self.assertLess(sum(middle[40:]) / len(middle[40:]), 40)
        self.assertIn("Fundo desfocado", render["framingNote"])


if __name__ == "__main__":
    unittest.main()
