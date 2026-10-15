"""Seleção de cortes: validação, janelas, persistência, falhas e retomada.

Usa um Ollama falso (tests/fake_ollama.py) e a aplicação falsa (tests/fake_app.py).
O teste com o modelo de verdade fica em test_selection_real.py.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.ollama import OllamaClient
from cca_worker.runner import JobRunner, run_loop
from cca_worker.selection import (
    SELECTION_FILE,
    SelectionStage,
    build_windows,
    merge_candidates,
    parse_model_output,
    selection_key,
    validate_candidates,
    InvalidModelOutput,
)
from cca_worker.scoring import final_score

from tests.fake_app import FakeApp
from tests.fake_ollama import FakeOllama, good_reply, window_of


def make_segments(count: int, length: float = 6.0) -> list[dict]:
    return [{"id": i, "startSec": i * length, "endSec": i * length + length - 0.4, "text": f"Frase número {i}."} for i in range(count)]


class FakeTranscriber:
    name = "fake"

    def transcribe(self, audio, on_progress):  # não deve ser chamado nestes testes
        raise AssertionError("a seleção não pode transcrever de novo")


# ---------------------------------------------------------------------------
# Funções puras


class WindowTests(unittest.TestCase):
    def test_windows_cover_every_segment_with_overlap(self):
        segs = make_segments(100)  # 600 s
        windows = build_windows(segs, 180, 30)
        covered = {i for a, b in windows for i in range(a, b + 1)}
        self.assertEqual(covered, set(range(100)))
        for (a1, b1), (a2, _) in zip(windows, windows[1:]):
            self.assertLess(a2, b1 + 1, "janelas seguidas devem se sobrepor")
            self.assertGreater(a2, a1)

    def test_short_video_is_one_window_and_empty_is_none(self):
        self.assertEqual(build_windows(make_segments(5), 480, 60), [(0, 4)])
        self.assertEqual(build_windows([], 480, 60), [])


class ParseTests(unittest.TestCase):
    def test_accepts_plain_json_and_code_fence(self):
        self.assertEqual(parse_model_output('{"clips": []}'), [])
        self.assertEqual(len(parse_model_output('```json\n{"clips": [{"a": 1}]}\n```')), 1)

    def test_rejects_broken_output(self):
        for bad in ("não é json", '{"cortes": []}', '{"clips": "x"}', '{"clips": [1, 2]}', "[]"):
            with self.assertRaises(InvalidModelOutput, msg=bad):
                parse_model_output(bad)


RATINGS = {"hook": 4, "clarity": 3, "value": 4, "standalone": 3, "pacing": 3}


def cand(s, e, **kw):
    base = {"start_segment": s, "end_segment": e, "title": "Título", "hook": "Gancho", "reason": "Motivo", "ratings": dict(RATINGS), "tags": []}
    base.update(kw)
    return base


class ValidationTests(unittest.TestCase):
    segs = make_segments(40)  # trechos de 6 s; o último termina em 239,6 s

    def check(self, raw, window=(0, 39), duration=240.0, min_sec=15, max_sec=90):
        return validate_candidates(raw, self.segs, window, duration, min_sec, max_sec)

    def test_seconds_come_from_the_transcript(self):
        valid, rejected = self.check([cand(2, 6)])
        self.assertEqual(rejected, [])
        # Frases 2–6: 12,0–41,6 s, com folga de 0,12 s antes e 0,30 s depois
        # (os vizinhos estão a 0,4 s, então a folga não invade outra fala).
        self.assertEqual((valid[0]["startSec"], valid[0]["endSec"]), (11.88, 41.9))
        self.assertEqual(valid[0]["transcript"], "Frase número 2. Frase número 3. Frase número 4. Frase número 5. Frase número 6.")

    def test_every_clip_is_inside_the_video_and_within_duration_limits(self):
        raw = [cand(s, e) for s in range(0, 40, 3) for e in (s, s + 2, s + 9, s + 30)]
        valid, _ = self.check(raw, duration=239.6)
        self.assertTrue(valid)
        for c in valid:
            self.assertGreaterEqual(c["startSec"], 0)
            self.assertLessEqual(c["endSec"], 239.6)
            self.assertGreaterEqual(c["endSec"] - c["startSec"], 15)
            self.assertLessEqual(c["endSec"] - c["startSec"], 90)

    def test_rejects_segments_outside_window_reversed_or_missing(self):
        valid, rejected = self.check([cand(0, 5), cand(10, 8), cand(None, 5), cand(-1, 3), cand(38, 45)], window=(5, 39))
        self.assertEqual(valid, [])
        self.assertEqual(len(rejected), 5)

    def test_too_long_is_trimmed_and_too_short_is_extended(self):
        valid, _ = self.check([cand(0, 30), cand(10, 10)])
        self.assertLessEqual(valid[0]["endSec"] - valid[0]["startSec"], 90)
        self.assertGreaterEqual(valid[1]["endSec"] - valid[1]["startSec"], 15)
        self.assertEqual(valid[1]["startSec"], 59.88, "o início sugerido é mantido (com a folga)")

    def test_end_after_video_is_rejected_or_rounded(self):
        _, rejected = self.check([cand(30, 39)], duration=200.0)
        self.assertIn("depois do fim do vídeo", rejected[0])
        valid, _ = self.check([cand(30, 39)], duration=239.0)  # 0,6 s de arredondamento
        self.assertEqual(valid[0]["endSec"], 239.0)

    def test_quotes_fix_wrong_segment_numbers(self):
        segs = [{"startSec": i * 6.0, "endSec": i * 6.0 + 5.6, "text": t} for i, t in enumerate(
            ["Bom dia a todos.", "Eu perdi trinta mil reais em uma semana.", "Foi um golpe de investimento.", "A lição: desconfie de retorno garantido.", "Agora vamos falar de café.", "Fim do episódio, valeu."] * 2
        )]  # fmt: skip
        # Número 2 ("Foi um golpe…") mas a citação é do trecho 1: diferença de 1 trecho é corrigida.
        valid, rejected = validate_candidates([cand(2, 3, start_quote="eu perdi trinta mil reais em")], segs, (0, 5), 72.0, 15, 90)
        self.assertEqual(rejected, [])
        self.assertEqual((valid[0]["startSec"], valid[0]["endSec"]), (5.88, 23.9))
        self.assertTrue(valid[0]["transcript"].startswith("Eu perdi trinta mil"))
        # Número 4 (café) com citação do trecho 1 (golpe): o modelo misturou assuntos → descartado.
        valid, rejected = validate_candidates([cand(4, 5, start_quote="eu perdi trinta mil reais em")], segs, (0, 5), 72.0, 15, 90)
        self.assertEqual(valid, [])
        self.assertIn("citação inicial", rejected[0])

    def test_quote_matching_ignores_accents_and_punctuation(self):
        segs = [{"startSec": 0.0, "endSec": 10.0, "text": "Ninguém te conta isso: a inflação é cruel!"}, {"startSec": 10.0, "endSec": 20.0, "text": "Outra frase qualquer aqui."}]
        valid, _ = validate_candidates([cand(1, 1, start_quote="ninguem te conta isso a inflacao")], segs, (0, 1), 20.0, 15, 90)
        self.assertEqual(valid[0]["startSec"], 0.0)

    def test_unmatched_quote_falls_back_to_numbers(self):
        valid, _ = self.check([cand(2, 6, start_quote="texto que não existe em lugar nenhum")])
        self.assertEqual(valid[0]["startSec"], 11.88)

    def test_single_segment_longer_than_max_is_rejected(self):
        segs = [{"startSec": 0.0, "endSec": 200.0, "text": "monólogo"}]
        valid, rejected = validate_candidates([cand(0, 0)], segs, (0, 0), 200.0, 15, 90)
        self.assertEqual(valid, [])
        self.assertIn("duração", rejected[0])

    def test_text_fields_ratings_and_tags(self):
        valid, rejected = self.check(
            [
                cand(0, 4, title="  "),
                cand(0, 4, ratings={**RATINGS, "hook": "abc"}),
                cand(0, 4, ratings={**RATINGS, "value": True}),
                cand(0, 4, ratings={k: v for k, v in RATINGS.items() if k != "pacing"}),
                cand(0, 4, ratings=[4, 4, 4, 4, 4]),
                cand(0, 4, ratings={k: "9" for k in RATINGS}, title="x" * 200, tags=["Dica", "dica", 3, "a" * 50, "b", "c", "d"]),
            ]
        )
        self.assertEqual(len(rejected), 5)
        self.assertEqual(valid[0]["analysis"]["criteria"], {k: 5 for k in RATINGS}, "notas fora da faixa são limitadas a 1–5")
        self.assertEqual(valid[0]["score"], 100)
        self.assertLessEqual(len(valid[0]["title"]), 80)
        self.assertEqual(valid[0]["tags"][:2], ["dica", "a" * 23 + "…"])
        self.assertLessEqual(len(valid[0]["tags"]), 4)


def mk(s, e, level, text=None):
    criteria = {k: level for k in RATINGS}
    analysis = {"version": 1, "criteria": criteria, "redundancyPct": 0, "boundaries": {"start": "sentence", "end": "sentence"}, "adjustments": [], "warnings": []}
    return {"title": "t", "startSec": s, "endSec": e, "score": 0, "reason": "r", "hook": "h", "transcript": text or f"{s:06d}a {s:06d}b", "tags": [], "segments": [0, 1], "analysis": analysis}


class MergeTests(unittest.TestCase):
    def test_removes_overlaps_keeps_best_and_assigns_ids(self):
        final = merge_candidates([mk(0, 30, 3), mk(5, 35, 5), mk(100, 130, 2), mk(200, 230, 4)], max_clips=2)
        self.assertEqual([(c["id"], c["startSec"], c["score"]) for c in final], [("c1", 5, 100), ("c2", 200, 75)])
        self.assertNotIn("segments", final[0])
        self.assertEqual(final[0]["analysis"]["redundancyPct"], 0)

    def test_same_story_twice_is_removed_and_partial_repetition_is_penalized(self):
        story = "Perdi trinta mil reais investindo numa pirâmide financeira que prometia dobrar dinheiro rapidamente"
        retold = "Lembra quando perdi trinta mil reais naquela pirâmide financeira que prometia dobrar dinheiro?"
        partial = "Investindo hoje aprendi diversificar carteira, estudar empresas, comparar taxas antes aplicar dinheiro"
        final = merge_candidates([mk(0, 40, 5, story), mk(300, 340, 4, retold), mk(600, 640, 4, partial)], max_clips=5)
        self.assertEqual([c["startSec"] for c in final], [0, 600], "a mesma história contada de novo é descartada")
        penalized = final[1]
        self.assertGreater(penalized["analysis"]["redundancyPct"], 0)
        self.assertEqual(penalized["score"], final_score(penalized["analysis"]["criteria"], penalized["analysis"]["redundancyPct"]))
        self.assertLess(penalized["score"], 75)


# ---------------------------------------------------------------------------
# Etapa completa


class SelectionStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-select-test-"))
        self.app = FakeApp().__enter__()
        self.ollama = FakeOllama().__enter__()
        self.env = {
            "CCA_APP_URL": self.app.url,
            "CCA_WORKER_TOKEN": self.app.token,
            "CCA_OLLAMA_URL": self.ollama.url,
            "CCA_SELECT_WINDOW_SEC": "180",
            "CCA_SELECT_OVERLAP_SEC": "30",
            "CCA_WORKER_POLL_SECONDS": "1",
        }
        self.settings = load_settings(self.tmp, environ=self.env)
        self.api = WorkerApi(self.app.url, self.app.token)

    def tearDown(self):
        self.ollama.stop()
        self.app.__exit__()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add_project(self, pid="p_sel", segments=None, duration=240.0, history=None) -> Path:
        media = self.tmp / ".data" / "media" / pid
        media.mkdir(parents=True, exist_ok=True)
        video = media / "source-abc.mp4"
        video.write_bytes(b"video autorizado")
        segs = make_segments(40) if segments is None else segments
        (media / "transcript.json").write_text(
            json.dumps({"version": 1, "source": {"file": video.name}, "durationSec": duration, "segments": segs}, ensure_ascii=False), encoding="utf-8"
        )
        self.app.add(pid, "selecting", f"media\\{pid}\\{video.name}", str(video), duration=duration)
        if history:
            self.app.projects[pid]["history"] = history
        return media

    def stage(self, settings=None):
        s = settings or self.settings
        return SelectionStage(s, self.api, OllamaClient(s.ollama_url, timeout=10))

    def run_once(self, stage=None):
        return run_loop(JobRunner(self.settings, self.api, FakeTranscriber(), stage or self.stage()), once=True)

    def test_selects_validates_saves_and_moves_to_review(self):
        media = self.add_project()
        outcomes = self.run_once()
        self.assertEqual([o.result for o in outcomes], ["completed"])

        project = self.app.projects["p_sel"]
        self.assertEqual(project["status"], "review")
        clips = project["clips"]
        self.assertTrue(clips)
        self.assertEqual(len({c["id"] for c in clips}), len(clips))
        for c in clips:
            self.assertTrue(0 <= c["startSec"] < c["endSec"] <= 240.0)
            self.assertTrue(15 <= c["endSec"] - c["startSec"] <= 90)
        self.assertIn("modelo local qwen2.5:7b", project["history"][-1]["note"])

        saved = json.loads((media / SELECTION_FILE).read_text(encoding="utf-8"))
        self.assertEqual(saved["final"], [{k: v for k, v in c.items() if k != "decision"} for c in clips])
        self.assertTrue((media / "transcript.json").exists())
        # Toda chamada ao modelo foi local, com o esquema JSON e sem streaming.
        self.assertTrue(all(c["format"]["required"] == ["clips"] and c["stream"] is False for c in self.ollama.chats))

    def test_resumes_after_restart_without_repeating_finished_parts(self):
        self.add_project()
        calls: list[int] = []

        def crash_after_first(body):
            calls.append(1)
            if len(calls) == 1:
                self.ollama.models.clear()  # o "Ollama cai" no meio da seleção
            return good_reply(body)

        self.ollama.reply = crash_after_first
        stage = self.stage()
        first = self.run_once(stage)
        self.assertEqual(first[0].result, "interrupted")
        self.assertEqual(self.app.projects["p_sel"]["status"], "selecting", "a transcrição e o estado são preservados")
        before = len(self.ollama.chats)

        self.ollama.models.append("qwen2.5:7b")
        self.ollama.reply = good_reply
        second = self.run_once(stage)
        self.assertEqual(second[0].result, "completed")
        windows = build_windows(make_segments(40), 180, 30)
        self.assertEqual(len(self.ollama.chats) - before, len(windows) - 1, "só as partes que faltavam foram enviadas ao modelo")

    def test_final_result_is_reused_not_duplicated(self):
        self.add_project()
        self.run_once()
        clips = self.app.projects["p_sel"]["clips"]
        # O worker caiu depois de salvar e antes de avisar: o projeto ainda está em "selecting".
        self.app.projects["p_sel"].update(status="selecting", job={"state": "running", "progress": 0.99})
        calls = len(self.ollama.chats)
        outcomes = self.run_once()
        self.assertEqual(outcomes[0].result, "reused")
        self.assertEqual(len(self.ollama.chats), calls)
        self.assertEqual(self.app.projects["p_sel"]["clips"], clips)

    def test_new_round_ignores_previous_cache(self):
        self.add_project()
        self.run_once()
        calls = len(self.ollama.chats)
        # "Gerar novas sugestões": o projeto entra em selecting de novo (rodada 2).
        p = self.app.projects["p_sel"]
        p.update(status="selecting", job={"state": "queued", "progress": 0})
        p["history"] = [{"status": "selecting"}, {"status": "review"}, {"status": "selecting"}]
        self.assertEqual(self.run_once()[0].result, "completed")
        self.assertGreater(len(self.ollama.chats), calls)
        seeds = {c["options"]["seed"] for c in self.ollama.chats}
        self.assertGreater(len(seeds), len(self.ollama.chats) // 2, "rodadas diferentes usam sementes diferentes")

    def test_invalid_output_is_retried(self):
        self.add_project()
        attempts: dict[tuple, int] = {}

        def flaky(body):
            w = window_of(body)
            attempts[w] = attempts.get(w, 0) + 1
            return "isto não é json" if attempts[w] == 1 else good_reply(body)

        self.ollama.reply = flaky
        self.assertEqual(self.run_once()[0].result, "completed")
        self.assertTrue(all(n == 2 for n in attempts.values()))
        temps = [c["options"]["temperature"] for c in self.ollama.chats]
        self.assertIn(0.7, temps, "a nova tentativa varia a temperatura")

    def test_persistent_invalid_output_fails_without_losing_transcript(self):
        media = self.add_project()
        self.ollama.reply = lambda body: "{quebrado"
        outcome = self.run_once()[0]
        self.assertEqual(outcome.result, "failed")
        project = self.app.projects["p_sel"]
        self.assertEqual(project["status"], "failed")
        self.assertEqual(project["error"]["stage"], "select")
        self.assertIn("não gerou respostas válidas", project["error"]["message"])
        self.assertTrue((media / "transcript.json").exists())

    def test_server_errors_are_retried_then_fail(self):
        self.add_project()
        self.ollama.fail_chat_with = 500
        self.assertEqual(self.run_once()[0].result, "failed")
        self.assertEqual(len(self.ollama.chats), 3 * len(build_windows(make_segments(40), 180, 30)))

    def test_no_valid_clip_fails_with_clear_message(self):
        self.add_project()
        self.ollama.reply = lambda body: json.dumps({"clips": [{"start_segment": 999, "end_segment": 1000, "title": "x", "hook": "h", "reason": "r", "score": 50, "tags": []}]})
        self.run_once()
        self.assertIn("Nenhum trecho adequado", self.app.projects["p_sel"]["error"]["message"])

    def test_ollama_offline_keeps_project_waiting(self):
        self.add_project()
        self.ollama.stop()
        outcomes = self.run_once()
        self.assertEqual(outcomes, [])
        self.assertEqual(self.app.projects["p_sel"]["status"], "selecting")
        self.assertEqual([c for c in self.app.calls if c[0] == "POST"], [], "nada é alterado enquanto o Ollama está fora")
        self.assertIn("Ollama sem resposta", self.stage().check_ready())

    def test_missing_model_is_reported(self):
        self.ollama.models = ["outro:1b"]
        self.assertIn("ollama pull qwen2.5:7b", self.stage().check_ready())

    def test_missing_transcript_fails_on_transcribe_stage(self):
        media = self.add_project()
        (media / "transcript.json").unlink()
        self.run_once()
        error = self.app.projects["p_sel"]["error"]
        self.assertEqual(error["stage"], "transcribe")
        self.assertEqual(self.ollama.chats, [])

    def test_video_shorter_than_minimum_clip(self):
        self.add_project(segments=make_segments(1), duration=5.0)
        self.run_once()
        self.assertIn("menos que a duração mínima", self.app.projects["p_sel"]["error"]["message"])

    def test_cache_key_changes_with_transcript_model_and_round(self):
        k = lambda data, run=1, s=self.settings: selection_key(data, s, run)
        other = load_settings(self.tmp, environ={**self.env, "CCA_SELECT_MODEL": "qwen2.5:3b"})
        self.assertEqual(k(b"a"), k(b"a"))
        self.assertNotEqual(k(b"a"), k(b"b"))
        self.assertNotEqual(k(b"a"), k(b"a", run=2))
        self.assertNotEqual(k(b"a"), k(b"a", s=other))


class OllamaConfigTests(unittest.TestCase):
    def test_only_local_ollama_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            for url in ("http://exemplo.com:11434", "https://127.0.0.1:11434", "http://192.168.0.10:11434"):
                with self.assertRaises(ValueError, msg=url):
                    load_settings(Path(tmp), environ={"CCA_OLLAMA_URL": url})
            self.assertEqual(load_settings(Path(tmp), environ={"CCA_OLLAMA_URL": "http://localhost:11434"}).ollama_url, "http://localhost:11434")

    def test_clip_limits_must_be_consistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                load_settings(Path(tmp), environ={"CCA_CLIP_MIN_SEC": "60", "CCA_CLIP_MAX_SEC": "30"})


if __name__ == "__main__":
    unittest.main()
