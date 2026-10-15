"""Seleção com o modelo de verdade (Ollama local).

Usa uma transcrição FICTÍCIA escrita para testes (tests/fixtures). É pulado se
o Ollama não estiver rodando ou o modelo configurado não estiver instalado.
Defina CCA_PRINT_CLIPS=1 para ver as sugestões.
"""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.ollama import OllamaClient, OllamaError
from cca_worker.runner import JobRunner, run_loop
from cca_worker.selection import SELECTION_FILE, SelectionStage

from tests.fake_app import FakeApp

FIXTURE = Path(__file__).parent / "fixtures" / "transcript_podcast_ficticio.json"
SETTINGS = load_settings()


def model_ready() -> bool:
    try:
        return OllamaClient(SETTINGS.ollama_url, timeout=5).has_model(SETTINGS.select_model)
    except OllamaError:
        return False


@unittest.skipUnless(model_ready(), f"Ollama ou modelo '{SETTINGS.select_model}' indisponível")
class RealSelectionTests(unittest.TestCase):
    def test_real_model_returns_valid_clips(self):
        transcript = json.loads(FIXTURE.read_text(encoding="utf-8"))
        duration = transcript["durationSec"]
        with tempfile.TemporaryDirectory(prefix="cca-select-real-") as tmp, FakeApp() as app:
            tmp = Path(tmp)
            media = tmp / ".data" / "media" / "p_real"
            media.mkdir(parents=True)
            video = media / "source-x.mp4"
            video.write_bytes(b"x")
            (media / "transcript.json").write_text(json.dumps({**transcript, "source": {"file": video.name}}, ensure_ascii=False), encoding="utf-8")
            app.add("p_real", "selecting", "media\\p_real\\source-x.mp4", str(video), duration=duration)

            env = {**os.environ, "CCA_APP_URL": app.url, "CCA_WORKER_TOKEN": app.token}
            settings = load_settings(tmp, environ=env)
            api = WorkerApi(app.url, app.token)
            stage = SelectionStage(settings, api, OllamaClient(settings.ollama_url))
            outcomes = run_loop(JobRunner(settings, api, None, stage), once=True)

            project = app.projects["p_real"]
            self.assertEqual([o.result for o in outcomes], ["completed"], project.get("error"))
            self.assertEqual(project["status"], "review")
            clips = project["clips"]
            self.assertGreaterEqual(len(clips), 1)
            for c in clips:
                self.assertTrue(0 <= c["startSec"] < c["endSec"] <= duration, c)
                self.assertTrue(settings.clip_min_sec <= c["endSec"] - c["startSec"] <= settings.clip_max_sec, c)
                self.assertTrue(c["title"] and c["hook"] and c["reason"])
                self.assertTrue(0 <= c["score"] <= 100)
            self.assertTrue((media / SELECTION_FILE).exists())

            if os.environ.get("CCA_PRINT_CLIPS"):
                for c in clips:
                    print(f"\n{c['id']} {c['startSec']:.1f}-{c['endSec']:.1f}s ({c['endSec'] - c['startSec']:.0f}s) score {c['score']} {c['tags']}")
                    print(f"  título: {c['title']}\n  gancho: {c['hook']}\n  motivo: {c['reason']}\n  texto: {c['transcript'][:160]}…")


if __name__ == "__main__":
    unittest.main()
