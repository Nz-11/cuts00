"""Fluxo do worker contra um servidor falso, com FFmpeg real e transcritor falso.

A transcrição real (modelo Whisper) é testada à parte em test_whisper_real.py.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from cca_worker import runner as runner_mod
from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.runner import FatalConfigError, JobRunner, SingleInstanceLock, clean_stale_workdirs, run_loop
from cca_worker.transcribe import TranscriptResult

from tests.fake_app import FakeApp

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def make_video(path: Path, with_audio: bool = True, seconds: int = 2) -> Path:
    args = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size=160x120:rate=10:duration={seconds}"]
    if with_audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"] + (["-c:a", "aac", "-shortest"] if with_audio else []) + ["-y", str(path)]
    subprocess.run(args, check=True)
    return path


class FakeTranscriber:
    name = "fake"

    def __init__(self, fail: Exception | None = None, segments=None):
        self.calls: list[Path] = []
        self.fail = fail
        self.segments = segments if segments is not None else [
            {"id": 0, "startSec": 0.0, "endSec": 1.2, "text": "Olá, pessoal.", "words": [{"word": "Olá,", "startSec": 0.0, "endSec": 0.5, "probability": 0.9}, {"word": "pessoal.", "startSec": 0.5, "endSec": 1.2, "probability": 0.95}]},
            {"id": 1, "startSec": 1.2, "endSec": 2.0, "text": "Bem-vindos.", "words": [{"word": "Bem-vindos.", "startSec": 1.2, "endSec": 2.0, "probability": 0.8}]},
        ]

    def transcribe(self, audio: Path, on_progress):
        self.calls.append(audio)
        assert audio.is_file(), "o áudio extraído deveria existir durante a transcrição"
        header = audio.read_bytes()[:4]
        assert header == b"RIFF", "o áudio deveria ser WAV"
        for t in (0.5, 1.0, 2.0):
            on_progress(t, 2.0)
        if self.fail:
            raise self.fail
        return TranscriptResult(language="pt", language_probability=0.99, duration_sec=2.0, segments=self.segments)


@unittest.skipUnless(HAS_FFMPEG, "FFmpeg não instalado")
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self._interval = runner_mod.PROGRESS_INTERVAL_SEC
        runner_mod.PROGRESS_INTERVAL_SEC = 0
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-worker-test-"))
        self.app = FakeApp().__enter__()
        self.settings = load_settings(self.tmp, environ={"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "CCA_WORKER_POLL_SECONDS": "1"})
        self.api = WorkerApi(self.app.url, self.app.token)

    def tearDown(self):
        runner_mod.PROGRESS_INTERVAL_SEC = self._interval
        self.app.__exit__()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add_project(self, pid: str, status="transcribing", with_audio=True, state="queued") -> Path:
        media = self.tmp / ".data" / "media" / pid
        media.mkdir(parents=True, exist_ok=True)
        video = make_video(media / "source-abc.mp4", with_audio)
        self.app.add(pid, status, f"media\\{pid}\\source-abc.mp4", str(video), state=state)
        return video

    def run_once(self, transcriber):
        return run_loop(JobRunner(self.settings, self.api, transcriber), once=True)

    def test_transcribes_saves_and_moves_to_selecting(self):
        video = self.add_project("p_ok")
        fake = FakeTranscriber()
        outcomes = self.run_once(fake)

        self.assertEqual([o.result for o in outcomes], ["completed"])
        project = self.app.projects["p_ok"]
        self.assertEqual(project["status"], "selecting")
        self.assertIn("2 trechos, 3 palavras", project["history"][-1]["note"])

        data = json.loads((video.parent / "transcript.json").read_text(encoding="utf-8"))
        self.assertEqual(data["language"], "pt")
        self.assertEqual(data["segments"][0]["words"][0]["startSec"], 0.0)
        self.assertEqual(data["source"]["file"], "source-abc.mp4")
        self.assertEqual(data["text"], "Olá, pessoal. Bem-vindos.")

        progress = [b["progress"] for b in self.app.bodies("p_ok", "progress")]
        self.assertEqual(progress, sorted(progress), "o progresso não deve voltar")
        self.assertTrue(all(0 <= p <= 1 for p in progress))
        self.assertFalse(fake.calls[0].exists(), "o WAV temporário deve ser apagado")
        self.assertEqual(fake.calls[0].parent.parent, self.settings.data_dir / "tmp", "temporários ficam em <dados>/tmp")
        self.assertTrue(all(c[3] == f"Bearer {self.app.token}" for c in self.app.calls))

    def test_completed_project_is_not_processed_again(self):
        self.add_project("p_once")
        fake = FakeTranscriber()
        self.run_once(fake)
        self.assertEqual(self.run_once(fake), [])
        self.assertEqual(len(fake.calls), 1)

    def test_resumes_after_crash_reusing_saved_transcript(self):
        self.add_project("p_crash")
        self.run_once(FakeTranscriber())
        # Simula: transcrição salva, mas o worker caiu antes de avisar a aplicação.
        self.app.projects["p_crash"].update(status="transcribing", job={"state": "running", "progress": 0.6})
        fake = FakeTranscriber()
        outcomes = self.run_once(fake)
        self.assertEqual([o.result for o in outcomes], ["reused"])
        self.assertEqual(fake.calls, [])
        self.assertEqual(self.app.projects["p_crash"]["status"], "selecting")

    def test_saved_transcript_for_other_model_is_not_reused(self):
        self.add_project("p_model")
        self.run_once(FakeTranscriber())
        self.app.projects["p_model"].update(status="transcribing", job={"state": "queued", "progress": 0})
        other = load_settings(self.tmp, environ={"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "CCA_WHISPER_MODEL": "base"})
        fake = FakeTranscriber()
        run_loop(JobRunner(other, self.api, fake), once=True)
        self.assertEqual(len(fake.calls), 1)

    def test_video_without_audio_fails_and_can_be_retried(self):
        video = self.add_project("p_mute", with_audio=False)
        fake = FakeTranscriber()
        outcomes = self.run_once(fake)
        self.assertEqual([o.result for o in outcomes], ["failed"])
        project = self.app.projects["p_mute"]
        self.assertEqual(project["status"], "failed")
        self.assertEqual(project["error"]["stage"], "transcribe")
        self.assertIn("não tem faixa de áudio", project["error"]["message"])
        self.assertEqual(fake.calls, [])

        # Recuperação: o arquivo é corrigido e o usuário pede nova tentativa (failed → transcribing).
        make_video(video, with_audio=True)
        project.update(status="transcribing", job={"state": "queued", "progress": 0})
        self.assertEqual([o.result for o in self.run_once(fake)], ["completed"])

    def test_transcriber_error_marks_failed(self):
        self.add_project("p_err")
        outcomes = self.run_once(FakeTranscriber(fail=RuntimeError("modelo travou")))
        self.assertEqual(outcomes[0].result, "failed")
        self.assertIn("modelo travou", self.app.projects["p_err"]["error"]["message"])

    def test_no_speech_marks_failed(self):
        self.add_project("p_silent")
        self.run_once(FakeTranscriber(segments=[]))
        self.assertIn("Nenhuma fala", self.app.projects["p_silent"]["error"]["message"])

    def test_project_deleted_mid_transcription_is_cancelled(self):
        video = self.add_project("p_del")

        def delete_after_first(pid, body):
            if body["progress"] > 0.05:
                del self.app.projects[pid]

        self.app.on_progress = delete_after_first
        outcomes = self.run_once(FakeTranscriber())
        self.assertEqual(outcomes[0].result, "cancelled")
        self.assertFalse((video.parent / "transcript.json").exists())
        self.assertEqual(self.app.bodies("p_del", "transition"), [])

    def test_rejects_media_outside_data_dir(self):
        outside = make_video(self.tmp / "fora.mp4")
        self.app.add("p_evil", "transcribing", "../fora.mp4", str(outside))
        fake = FakeTranscriber()
        outcomes = self.run_once(fake)
        self.assertEqual(outcomes[0].result, "failed")
        self.assertEqual(fake.calls, [])
        self.assertIn("inválido", self.app.projects["p_evil"]["error"]["message"])

    def test_missing_file_marks_failed(self):
        video = self.add_project("p_gone")
        video.unlink()
        self.run_once(FakeTranscriber())
        self.assertIn("não foi encontrado", self.app.projects["p_gone"]["error"]["message"])

    def test_ignores_selecting_and_rendering(self):
        self.add_project("p_sel", status="selecting")
        self.add_project("p_ren", status="rendering")
        fake = FakeTranscriber()
        self.assertEqual(self.run_once(fake), [])
        self.assertEqual(fake.calls, [])
        self.assertEqual([c for c in self.app.calls if c[0] == "POST"], [])

    def test_fatal_config_errors(self):
        bad = JobRunner(self.settings, WorkerApi(self.app.url, "outro-token"), FakeTranscriber())
        with self.assertRaises(FatalConfigError):
            run_loop(bad, once=True)
        self.app.forced_status = 503
        with self.assertRaises(FatalConfigError):
            self.run_once(FakeTranscriber())

    def test_cleans_temp_left_by_a_crash(self):
        stale = self.settings.data_dir / "tmp" / "p_x-abc"
        stale.mkdir(parents=True)
        (stale / "audio-16k.wav").write_bytes(b"x" * 10)
        self.assertEqual(clean_stale_workdirs(self.settings), 1)
        self.assertFalse(stale.exists())

    def test_single_instance_lock(self):
        lock_path = self.tmp / "worker.lock"
        with SingleInstanceLock(lock_path):
            with self.assertRaises(RuntimeError):
                SingleInstanceLock(lock_path).acquire()
        with SingleInstanceLock(lock_path):
            pass  # liberada após o primeiro sair


if __name__ == "__main__":
    unittest.main()
