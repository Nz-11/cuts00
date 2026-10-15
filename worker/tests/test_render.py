"""Renderização com o FFmpeg real: corte, áudio, sincronia, enquadramento, legendas,
falhas, retomada, cancelamento e isolamento dos arquivos.

Os vídeos de origem são sintéticos, gerados localmente pelo próprio FFmpeg.
"""

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cca_worker import render as render_mod
from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.render import (
    RenderError,
    RenderSpec,
    RenderStage,
    ass_escape,
    ass_time,
    build_ass,
    build_command,
    clip_words,
    keyword_stems,
    loudness_gain_db,
    output_name,
    validate_clip,
    video_filter,
)
from cca_worker.runner import JobRunner, run_loop

from tests.fake_app import FakeApp

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def ff(*args: str) -> str:
    return subprocess.run(["ffmpeg", "-hide_banner", *args], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stderr


def make_source(path: Path, size: str = "1280x720", seconds: int = 12, sync_mark: float | None = None) -> Path:
    """Vídeo colorido com áudio. Com `sync_mark`, tela preta + flash branco e silêncio + bipe no mesmo instante."""
    if sync_mark is None:
        video = f"testsrc2=size={size}:rate=30:duration={seconds}"
        audio = f"sine=frequency=440:duration={seconds}"
    else:
        a, b = sync_mark, sync_mark + 0.5
        video = f"color=c=black:size={size}:rate=30:duration={seconds},drawbox=t=fill:c=white:enable='between(t,{a},{b})'"
        audio = f"sine=frequency=1000:duration={seconds},volume='if(between(t,{a},{b}),1,0)':eval=frame"
    ff("-v", "error", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", str(path))
    return path


def gray_frame(path: Path, at: float, w: int = 108, h: int = 192) -> bytes:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    )  # fmt: skip
    assert len(out.stdout) == w * h
    return out.stdout


def region(frame: bytes, y0: int, y1: int, w: int = 108) -> list[int]:
    return list(frame[y0 * w : y1 * w])


def variance(values: list[int]) -> float:
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / len(values)


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def loudness(path: Path, start: float, duration: float) -> tuple[float, float]:
    """(LUFS integrado, pico real em dBTP) medidos pelo FFmpeg."""
    log = ff("-ss", str(start), "-t", str(duration), "-i", str(path), "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-")
    data = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', log).group(0))
    return float(data["input_i"]), float(data["input_tp"])


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def approved(clip_id: str, start: float, end: float, framing: str = "crop", captions: str = "none", state: str = "queued") -> dict:
    return {
        "id": clip_id, "title": f"Corte {clip_id}", "startSec": start, "endSec": end, "score": 80, "reason": "r", "hook": "h",
        "transcript": "t", "tags": [], "decision": "approved",
        "render": {"state": state, "progress": 0, "framing": framing, "captions": captions, "startSec": start, "endSec": end},
    }  # fmt: skip


TRANSCRIPT_SEGMENTS = [
    {"startSec": 0.0, "endSec": 4.0, "text": "Olá pessoal, hoje tem novidade.", "words": [
        {"word": "Olá", "startSec": 0.0, "endSec": 0.5}, {"word": "pessoal,", "startSec": 0.5, "endSec": 1.2},
        {"word": "hoje", "startSec": 1.4, "endSec": 1.8}, {"word": "tem", "startSec": 1.8, "endSec": 2.1}, {"word": "novidade.", "startSec": 2.1, "endSec": 3.0}]},
    {"startSec": 4.0, "endSec": 12.0, "text": "Ação {\\pos(1,1)} única com acentuação e muito texto para quebrar a linha.", "words": [
        {"word": w, "startSec": 4.0 + i * 0.6, "endSec": 4.5 + i * 0.6} for i, w in enumerate("Ação {\\pos(1,1)} única com acentuação e muito texto para quebrar a linha.".split())]},
]  # fmt: skip


def dialogues(ass: str) -> list[str]:
    return [line for line in ass.splitlines() if line.startswith("Dialogue:")]


def visible_text(event: str) -> str:
    return re.sub(r"\{[^}]*\}", "", event.split(",", 9)[9])


def ts(value: str) -> float:
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def timed_words(text: str, step: float = 0.5):
    tokens = text.split()
    segment = {"startSec": 0.0, "endSec": len(tokens) * step, "text": text, "words": [{"word": w, "startSec": i * step, "endSec": i * step + step - 0.05} for i, w in enumerate(tokens)]}
    return clip_words([segment], 0.0, len(tokens) * step)


# ---------------------------------------------------------------------------
# Unidades


class ValidationTests(unittest.TestCase):
    def test_accepts_valid_and_clamps_tiny_overshoot(self):
        spec = validate_clip(approved("c1", 2, 10.03), media_duration=10.0)
        self.assertEqual((spec.start, spec.end, spec.framing, spec.captions), (2.0, 10.0, "crop", "none"))

    def test_rejects_invalid_requests(self):
        cases = {
            "não aprovado": {**approved("c1", 0, 5), "decision": "pending"},
            "sem render": {k: v for k, v in approved("c1", 0, 5).items() if k != "render"},
            "id com caminho": approved("../x", 0, 5),
            "enquadramento livre": approved("c1", 0, 5, framing="crop;rm -rf /"),
            "legenda livre": approved("c1", 0, 5, captions="subtitles=/etc/passwd"),
            "início negativo": approved("c1", -1, 5),
            "depois do fim": approved("c1", 2, 30),
            "curto demais": approved("c1", 2, 2.5),
            "longo demais": approved("c1", 0, 700),
        }
        for name, clip in cases.items():
            with self.assertRaises(RenderError, msg=name):
                validate_clip(clip, media_duration=20.0 if name != "longo demais" else 1000.0)
        bad = approved("c1", 0, 5)
        bad["render"]["startSec"] = "0; drop"
        with self.assertRaises(RenderError):
            validate_clip(bad, 20.0)
        bad["render"]["startSec"] = True
        with self.assertRaises(RenderError):
            validate_clip(bad, 20.0)

    def test_output_name_is_unique_per_options_and_safe(self):
        fp = {"file": "source-a.mp4", "sizeBytes": 1, "mtimeNs": 1}
        base = RenderSpec("c1", 1.0, 5.0, "crop", "classic")
        names = {
            output_name(base, fp),
            output_name(RenderSpec("c1", 1.0, 5.0, "blur", "classic"), fp),
            output_name(RenderSpec("c1", 1.0, 5.0, "crop", "highlight"), fp),
            output_name(RenderSpec("c1", 1.5, 5.0, "crop", "classic"), fp),
            output_name(base, {**fp, "sizeBytes": 2}),
            output_name(RenderSpec("c2", 1.0, 5.0, "crop", "classic"), fp),
        }
        self.assertEqual(len(names), 6)
        self.assertEqual(output_name(base, fp), output_name(base, fp))
        self.assertTrue(all(re.match(r"^[A-Za-z0-9_-]+\.mp4$", n) for n in names))

    def test_command_is_fixed_and_has_no_shell(self):
        settings = load_settings(Path(tempfile.gettempdir()), environ={})
        cmd = build_command(settings, Path("C:/dados/media/p_1/source x.mp4"), RenderSpec("c1", 1.5, 7.25, "blur", "highlight"), "out.mp4", True)
        self.assertIsInstance(cmd, list)
        self.assertEqual(cmd[cmd.index("-ss") + 1], "1.500")
        self.assertEqual(cmd[cmd.index("-t") + 1], "5.750")
        self.assertIn(str(Path("C:/dados/media/p_1/source x.mp4")), cmd)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("subtitles=captions.ass", graph)
        video, audio = graph.split(";[0:a:0]")
        self.assertTrue(video.endswith("format=yuv420p[v]"))
        self.assertEqual(audio, "volume=0.00dB,afade=t=in:st=0:d=0.02,afade=t=out:st=5.730:d=0.02[a]")
        self.assertEqual(cmd[cmd.index("[v]") + 2], "[a]")
        loud = build_command(settings, Path("x.mp4"), RenderSpec("c1", 0, 5, "crop", "none"), "o.mp4", False, -3.5)
        self.assertIn("volume=-3.50dB", loud[loud.index("-filter_complex") + 1])
        self.assertNotIn("subtitles", video_filter("crop", False))
        with self.assertRaises(RenderError):
            video_filter("outro", False)


class CaptionTests(unittest.TestCase):
    def test_words_are_relative_to_clip(self):
        words = clip_words(TRANSCRIPT_SEGMENTS, 0.6, 3.0)
        self.assertEqual([w.text for w in words], ["pessoal,", "hoje", "tem", "novidade."])
        self.assertAlmostEqual(words[0].start, 0.0)  # começava em 0,5 s: limitado ao início do corte
        self.assertAlmostEqual(words[1].start, 0.8)
        self.assertAlmostEqual(words[-1].end, 2.4)
        # Palavra cortada ao meio (ponto médio antes do início) fica de fora.
        self.assertEqual(clip_words(TRANSCRIPT_SEGMENTS, 1.0, 3.0)[0].text, "hoje")

    def test_segments_without_words_are_distributed(self):
        words = clip_words([{"startSec": 10.0, "endSec": 14.0, "text": "um dois três quatro"}], 10.0, 14.0)
        self.assertEqual([round(w.start, 2) for w in words], [0.0, 1.0, 2.0, 3.0])

    def test_escape_blocks_ass_overrides(self):
        self.assertEqual(ass_escape("a {\\pos(1,1)} b\\N c\n d"), "a (/pos(1,1)) b/N c d")
        ass = build_ass(clip_words(TRANSCRIPT_SEGMENTS, 0, 12), "classic", 12)
        events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
        self.assertTrue(events)
        self.assertFalse(any("{\\pos" in e for e in events))
        self.assertIn("Ação", ass)

    def test_ass_time(self):
        self.assertEqual(ass_time(3661.239), "1:01:01.24")
        self.assertEqual(ass_time(0), "0:00:00.00")

    def test_highlight_marks_one_word_at_a_time(self):
        ass = build_ass(clip_words(TRANSCRIPT_SEGMENTS, 0, 4), "highlight", 4)
        events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
        self.assertEqual(len(events), 5)  # uma linha por palavra
        for e in events:
            self.assertEqual(e.count("\\c&H0000E5FF&"), 1)
            self.assertNotRegex(e.split(",,", 1)[1].split("}", 1)[-1], r"[a-zà-ú]{3}", "texto em maiúsculas")
        starts = [e.split(",")[1] for e in events]
        self.assertEqual(starts, sorted(starts))

    def test_invalid_style(self):
        with self.assertRaises(RenderError):
            build_ass([], "neon", 5)

    def test_lines_are_short_balanced_and_never_end_on_weak_words(self):
        words = timed_words("Eu perdi todo o dinheiro que eu tinha guardado em uma única semana de muita confusão e de pura ingenuidade da minha parte.")
        for style, line_chars in (("classic", 24), ("keywords", 24), ("highlight", 14)):
            events = dialogues(build_ass(words, style, 30.0))
            self.assertTrue(events)
            for e in events:
                lines = visible_text(e).split("\\N")
                self.assertLessEqual(len(lines), 2, e)
                for line in lines:
                    self.assertLessEqual(len(line), line_chars + 12, e)  # uma palavra longa pode passar um pouco
                    self.assertNotIn(line.split()[-1].lower(), ("de", "o", "a", "que", "em", "e", "da", "uma"), f"linha terminando em palavra fraca: {e}")

    def test_captions_never_overlap_and_start_with_the_words(self):
        words = clip_words(TRANSCRIPT_SEGMENTS, 0.0, 12.0)
        for style in ("classic", "keywords", "highlight"):
            events = [(ts(e.split(",")[1]), ts(e.split(",")[2])) for e in dialogues(build_ass(words, style, 12.0))]
            for (s1, e1), (s2, _) in zip(events, events[1:]):
                self.assertLessEqual(e1, s2 + 0.001, style)
                self.assertLess(s1, e1)
        starts = [e.split(",")[1] for e in dialogues(build_ass(words, "classic", 12.0))]
        self.assertEqual(starts[0], "0:00:00.00")
        self.assertIn("0:00:04.00", starts, "depois do ponto final, a legenda seguinte começa com a palavra seguinte (4,0 s)")

    def test_keywords_highlight_at_most_one_relevant_word(self):
        words = timed_words("Eu perdi 30 mil reais numa pirâmide financeira. Depois disso eu mudei completamente a forma de investir.")
        events = dialogues(build_ass(words, "keywords", 30.0, keyword_stems("Pirâmide financeira", ["investimento"])))
        marked = [re.findall(r"\{\\c&H0000E5FF&\}([^{]+)\{", e) for e in events]
        self.assertTrue(all(len(m) <= 1 for m in marked))
        flat = [m[0] for m in marked if m]
        self.assertIn("30", flat, "números são destacados")
        self.assertTrue(set(flat) <= {"30", "pirâmide", "financeira.", "investir."}, flat)
        plain = dialogues(build_ass(words, "keywords", 30.0, set()))
        self.assertEqual([re.findall(r"E5FF&\}([^{]+)", e) for e in plain if "E5FF" in e], [["30"]], "sem título e tags, só números")

    def test_loudness_gain(self):
        self.assertEqual(loudness_gain_db(-30.0, -12.0), 11.0, "voz baixa sobe até perto de -14 LUFS, com o pico em -1 dBTP")
        self.assertEqual(loudness_gain_db(-24.0, -20.0), 10.0)
        self.assertEqual(loudness_gain_db(-8.0, -0.5), -6.0, "áudio alto demais desce")
        self.assertEqual(loudness_gain_db(-40.0, -30.0), 12.0, "ganho limitado a 12 dB")
        self.assertEqual(loudness_gain_db(-20.0, -1.5), 0.5, "pico alto limita o ganho: nada distorce")
        self.assertEqual(loudness_gain_db(float("-inf"), float("-inf")), 0.0, "silêncio não é amplificado")
        self.assertEqual(loudness_gain_db(None, None), 0.0)


# ---------------------------------------------------------------------------
# Integração com o FFmpeg real


@unittest.skipUnless(HAS_FFMPEG, "FFmpeg/ffprobe não instalados")
class RenderIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assets = Path(tempfile.mkdtemp(prefix="cca-render-assets-"))
        cls.horizontal = make_source(cls.assets / "h.mp4")
        cls.vertical = make_source(cls.assets / "v.mp4", size="720x1280", seconds=8)
        cls.sync = make_source(cls.assets / "sync.mp4", size="640x360", seconds=16, sync_mark=10.0)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.assets, ignore_errors=True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-render-test-"))
        self.app = FakeApp().__enter__()
        self.settings = load_settings(self.tmp, environ={"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "CCA_RENDER_PRESET": "ultrafast"})
        self.api = WorkerApi(self.app.url, self.app.token)

    def tearDown(self):
        self.app.__exit__()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add_project(self, pid: str, clips: list[dict], source: Path | None = None, transcript: bool = True) -> Path:
        media = self.tmp / ".data" / "media" / pid
        media.mkdir(parents=True)
        video = media / "source-abc.mp4"
        shutil.copy(source or self.horizontal, video)
        if transcript:
            (media / "transcript.json").write_text(json.dumps({"segments": TRANSCRIPT_SEGMENTS}, ensure_ascii=False), encoding="utf-8")
        duration = float(probe(video)["format"]["duration"])
        self.app.add(pid, "rendering", f"media/{pid}/{video.name}", str(video), duration=duration)
        self.app.projects[pid]["clips"] = clips
        return media

    def run_once(self):
        return run_loop(JobRunner(self.settings, self.api, None, None, RenderStage(self.settings, self.api)), once=True)

    def rendered(self, pid: str, clip_id: str) -> Path:
        render = next(c for c in self.app.projects[pid]["clips"] if c["id"] == clip_id)["render"]
        self.assertEqual(render["state"], "done", render.get("error"))
        return self.tmp / ".data" / "media" / pid / render["file"]

    def test_crop_with_captions_produces_vertical_mp4_with_audio(self):
        media = self.add_project("p_crop", [approved("c1", 2.0, 8.0, "crop", "classic")])
        original = sha256(media / "source-abc.mp4")
        outcomes = self.run_once()
        self.assertEqual([o.result for o in outcomes], ["completed"])
        out = self.rendered("p_crop", "c1")
        info = probe(out)
        video = next(s for s in info["streams"] if s["codec_type"] == "video")
        audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
        self.assertEqual((video["codec_name"], video["width"], video["height"], video["pix_fmt"]), ("h264", 1080, 1920, "yuv420p"))
        self.assertEqual((audio["codec_name"], audio["sample_rate"], audio["channels"]), ("aac", "48000", 2))
        self.assertAlmostEqual(float(info["format"]["duration"]), 6.0, delta=0.15)
        self.assertEqual(out.parent.name, "renders")
        self.assertEqual(sha256(media / "source-abc.mp4"), original, "o vídeo original não pode mudar")
        self.assertEqual(self.app.projects["p_crop"]["status"], "completed")
        self.assertIn(("p_crop", "c1", "running"), self.app.render_events)
        self.assertEqual(list((self.tmp / ".data" / "tmp").iterdir()), [], "temporários removidos")
        # +faststart: o índice (moov) vem antes dos dados (mdat), para tocar no navegador sem baixar tudo.
        head = out.read_bytes()[:4096]
        self.assertLess(head.find(b"moov"), head.find(b"mdat") if b"mdat" in head else 10**9)

    def test_audio_and_video_stay_in_sync(self):
        self.add_project("p_sync", [approved("c1", 8.0, 14.0, "crop", "none")], source=self.sync, transcript=False)
        self.run_once()
        out = self.rendered("p_sync", "c1")
        log = ff("-i", str(out), "-vf", "blackdetect=d=0.1:pix_th=0.1", "-af", "silencedetect=n=-30dB:d=0.2", "-f", "null", "-")
        flash = float(re.search(r"black_end:\s*([\d.]+)", log).group(1))
        beep = float(re.search(r"silence_end:\s*([\d.]+)", log).group(1))
        self.assertAlmostEqual(flash, 2.0, delta=0.1, msg="o flash da fonte (10 s) deve aparecer em 2 s do corte")
        self.assertAlmostEqual(beep, 2.0, delta=0.1, msg="o bipe da fonte (10 s) deve aparecer em 2 s do corte")
        self.assertLess(abs(flash - beep), 0.1)

    def test_blur_keeps_whole_image_without_distortion(self):
        self.add_project("p_blur", [approved("c1", 1.0, 5.0, "blur", "none"), approved("c2", 1.0, 5.0, "crop", "none")])
        self.run_once()
        w, h = 216, 384  # 1/5 de 1080×1920
        blur = gray_frame(self.rendered("p_blur", "c1"), 1.0, w, h)
        crop = gray_frame(self.rendered("p_blur", "c2"), 1.0, w, h)

        def sharpness(frame: bytes, y: int) -> int:  # maior salto entre pixels vizinhos: bordas nítidas dão dezenas
            row = frame[y * w : (y + 1) * w]
            return max(abs(row[x + 1] - row[x]) for x in range(w - 1))

        sharp_rows = [y for y in range(h) if sharpness(blur, y) > 25]
        band = max(sharp_rows) - min(sharp_rows) + 1
        # Fonte 1280×720 em 1080 de largura → 608 px de altura (121,6 linhas nesta escala), centralizada.
        self.assertAlmostEqual(band, 121.6, delta=4, msg="a imagem inteira mantém a proporção 16:9 (sem distorção)")
        self.assertAlmostEqual((min(sharp_rows) + max(sharp_rows)) / 2, h / 2, delta=3, msg="centralizada")
        self.assertGreater(min(blur[: 100 * w]), 0, "a área de cima é o fundo desfocado, sem barras pretas")
        self.assertTrue(all(sharpness(crop, y) > 25 for y in range(5, h - 5, 10)), "o recorte central preenche a tela toda")

    def test_low_resolution_source_is_not_overscaled_and_keeps_captions_and_audio(self):
        low = self.assets / "low.mp4"
        ff("-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", str(low))  # fmt: skip
        self.add_project("p_low", [approved("c1", 0.0, 4.0, "crop", "classic"), approved("c2", 0.0, 4.0, "blur", "classic"), approved("c3", 0.0, 4.0, "crop", "none")], source=low)
        self.run_once()
        sizes = {}
        for cid in ("c1", "c2", "c3"):
            info = probe(self.rendered("p_low", cid))
            video = next(s for s in info["streams"] if s["codec_type"] == "video")
            sizes[cid] = (video["width"], video["height"])
            self.assertTrue(any(s["codec_type"] == "audio" for s in info["streams"]))
            self.assertAlmostEqual(float(info["format"]["duration"]), 4.0, delta=0.15)
        self.assertEqual(sizes, {"c1": (720, 1280), "c2": (1080, 1920), "c3": (720, 1280)}, "recorte de fonte 360p sai em 720×1280; fundo desfocado amplia pouco e fica em 1080×1920")
        render = next(c for c in self.app.projects["p_low"]["clips"] if c["id"] == "c1")["render"]
        self.assertIn("720×1280", render["qualityNote"])
        # Legenda continua na parte de baixo, na mesma proporção da tela, e o resto da imagem não muda.
        plain, captioned = gray_frame(self.rendered("p_low", "c3"), 0.8), gray_frame(self.rendered("p_low", "c1"), 0.8)
        diff = lambda y0, y1: sum(abs(a - b) for a, b in zip(region(plain, y0, y1), region(captioned, y0, y1))) / ((y1 - y0) * 108)
        self.assertGreater(diff(140, 175), 3)
        self.assertLess(diff(10, 60), 1)

    def test_vertical_source_in_both_framings(self):
        self.add_project("p_vert", [approved("c1", 1.0, 4.0, "crop", "none"), approved("c2", 4.0, 7.0, "blur", "none")], source=self.vertical, transcript=False)
        self.run_once()
        for cid in ("c1", "c2"):
            video = next(s for s in probe(self.rendered("p_vert", cid))["streams"] if s["codec_type"] == "video")
            self.assertEqual((video["width"], video["height"]), (1080, 1920))

    def test_captions_are_burned_and_styles_differ(self):
        self.add_project("p_cap", [approved("c1", 0.0, 4.0, "crop", "none"), approved("c2", 0.0, 4.0, "crop", "classic"), approved("c3", 0.0, 4.0, "crop", "highlight")])
        self.run_once()
        plain, classic, highlight = (gray_frame(self.rendered("p_cap", c), 0.8) for c in ("c1", "c2", "c3"))
        def diff(a, b, y0, y1):
            ra, rb = region(a, y0, y1), region(b, y0, y1)
            return sum(abs(x - y) for x, y in zip(ra, rb)) / len(ra)
        self.assertGreater(diff(plain, classic, 140, 175), 3, "legenda clássica na parte de baixo")
        self.assertGreater(diff(plain, highlight, 115, 150), 3, "legenda destaque mais acima")
        self.assertLess(diff(plain, classic, 10, 60), 1, "o resto da imagem não muda")

    def test_quiet_audio_is_raised_without_clipping(self):
        quiet = self.assets / "quiet.mp4"
        ff("-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=10", "-f", "lavfi", "-i", "sine=frequency=300:duration=10,volume=0.03",
           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", str(quiet))  # fmt: skip
        self.add_project("p_loud", [approved("c1", 1.0, 9.0, "crop", "none")], source=quiet, transcript=False)
        self.run_once()
        before, after = loudness(quiet, 1.0, 8.0), loudness(self.rendered("p_loud", "c1"), 0.0, 8.0)
        self.assertLess(before[0], -25)
        self.assertGreater(after[0] - before[0], 9, "o volume sobe")
        self.assertLessEqual(after[1], -0.5, "sem passar do limite de pico (não distorce)")

    def test_keywords_style_renders(self):
        self.add_project("p_kw", [approved("c1", 0.0, 4.0, "crop", "keywords")])
        self.run_once()
        info = probe(self.rendered("p_kw", "c1"))
        self.assertAlmostEqual(float(info["format"]["duration"]), 4.0, delta=0.15)

    def test_resume_reuses_existing_output_without_rerendering(self):
        self.add_project("p_res", [approved("c1", 1.0, 4.0)])
        self.run_once()
        out = self.rendered("p_res", "c1")
        mtime = out.stat().st_mtime_ns
        # Worker caiu depois de gerar o arquivo e antes de avisar: o corte volta como "running".
        p = self.app.projects["p_res"]
        p.update(status="rendering", job={"state": "running", "progress": 0.5})
        p["clips"][0]["render"].update(state="running", file=None)
        with mock.patch.object(render_mod, "run_ffmpeg", side_effect=AssertionError("não deveria renderizar de novo")):
            outcomes = self.run_once()
        self.assertEqual(outcomes[0].result, "completed")
        self.assertEqual(self.rendered("p_res", "c1"), out)
        self.assertEqual(out.stat().st_mtime_ns, mtime)

    def test_corrupt_previous_output_is_rendered_again(self):
        media = self.add_project("p_bad", [approved("c1", 1.0, 4.0)])
        self.run_once()
        out = self.rendered("p_bad", "c1")
        out.write_bytes(b"corrompido")
        p = self.app.projects["p_bad"]
        p.update(status="rendering", job={"state": "queued", "progress": 0})
        p["clips"][0]["render"]["state"] = "queued"
        self.run_once()
        self.assertGreater(self.rendered("p_bad", "c1").stat().st_size, 1000)
        self.assertTrue((media / "source-abc.mp4").exists())

    def test_partial_failure_completes_and_failed_clip_can_be_retried(self):
        self.add_project("p_part", [approved("c1", 1.0, 4.0), approved("c2", 5.0, 40.0)])
        self.run_once()
        p = self.app.projects["p_part"]
        self.assertEqual(p["status"], "completed")
        self.assertIn("1 com falha", p["history"][-1]["note"])
        failed = p["clips"][1]["render"]
        self.assertEqual(failed["state"], "failed")
        self.assertIn("depois do fim do vídeo", failed["error"])
        # Tentar novamente com o corte ajustado.
        p.update(status="rendering", job={"state": "queued", "progress": 0})
        p["clips"][1]["render"].update(state="queued", endSec=9.0)
        self.run_once()
        self.assertEqual(self.rendered("p_part", "c2").parent.name, "renders")

    def test_all_failed_marks_project_failed_on_render_stage(self):
        self.add_project("p_fail", [approved("c1", 1.0, 4.0)])
        broken = load_settings(self.tmp, environ={"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "FFMPEG_PATH": "ffmpeg-que-nao-existe"})
        run_loop(JobRunner(broken, self.api, None, None, RenderStage(broken, self.api)), once=True)
        p = self.app.projects["p_fail"]
        self.assertEqual(p["status"], "failed")
        self.assertEqual(p["error"]["stage"], "render")
        self.assertIn("FFmpeg não encontrado", p["error"]["message"])

    def test_captions_without_transcript_fail_only_that_clip(self):
        self.add_project("p_notr", [approved("c1", 1.0, 4.0, captions="classic"), approved("c2", 1.0, 4.0, captions="none")], transcript=False)
        self.run_once()
        clips = self.app.projects["p_notr"]["clips"]
        self.assertIn("transcrição", clips[0]["render"]["error"])
        self.assertEqual(clips[1]["render"]["state"], "done")

    def test_project_deleted_during_render_cancels_and_leaves_nothing(self):
        media = self.add_project("p_del", [approved("c1", 0.0, 10.0)])

        def delete_on_progress(pid, body):
            if body.get("state") == "running" and body.get("progress", 0) > 0:
                self.app.projects.pop(pid, None)

        self.app.on_clip = delete_on_progress
        with mock.patch.object(render_mod, "PROGRESS_INTERVAL_SEC", 0):
            outcomes = self.run_once()
        self.assertEqual(outcomes[0].result, "cancelled")
        self.assertEqual(list((media / "renders").iterdir()), [], "nenhum MP4 parcial na pasta do projeto")
        self.assertEqual(list((self.tmp / ".data" / "tmp").iterdir()), [], "temporários removidos")

    def test_outputs_are_isolated_and_never_overwrite(self):
        media = self.add_project("p_iso", [approved("c1", 1.0, 4.0, "crop"), approved("c2", 5.0, 8.0, "crop")])
        self.run_once()
        first = {c: self.rendered("p_iso", c) for c in ("c1", "c2")}
        self.assertNotEqual(first["c1"], first["c2"])
        hashes = {c: sha256(p) for c, p in first.items()}
        # Renderizar c1 de novo com outro enquadramento cria outro arquivo; os anteriores ficam intactos.
        p = self.app.projects["p_iso"]
        p.update(status="rendering", job={"state": "queued", "progress": 0})
        p["clips"][0]["render"].update(state="queued", framing="blur")
        self.run_once()
        self.assertNotEqual(self.rendered("p_iso", "c1"), first["c1"])
        for c, path in first.items():
            self.assertEqual(sha256(path), hashes[c])
        self.assertEqual(sorted(x.name for x in media.iterdir()), ["renders", "source-abc.mp4", "transcript.json"])
        self.assertEqual(len(list((media / "renders").iterdir())), 3)

    def test_media_outside_data_dir_is_refused(self):
        outside = self.tmp / "fora.mp4"
        shutil.copy(self.horizontal, outside)
        self.app.add("p_evil", "rendering", "../fora.mp4", str(outside), duration=12.0)
        self.app.projects["p_evil"]["clips"] = [approved("c1", 1.0, 4.0)]
        with mock.patch.object(render_mod, "run_ffmpeg", side_effect=AssertionError("não pode renderizar")):
            self.run_once()
        self.assertEqual(self.app.projects["p_evil"]["status"], "failed")
        self.assertFalse((self.tmp / "renders").exists())


if __name__ == "__main__":
    unittest.main()
