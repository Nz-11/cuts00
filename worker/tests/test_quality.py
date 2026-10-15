"""Qualidade da seleção: frases completas, bordas, fidelidade à fala, pontuação e falhas do Ollama."""

import json
import random
import shutil
import tempfile
import unittest
from pathlib import Path

from cca_worker.api import WorkerApi
from cca_worker.config import load_settings
from cca_worker.ollama import OllamaClient, OllamaError
from cca_worker.runner import JobRunner, run_loop
from cca_worker.scoring import CRITERIA, WEIGHTS, final_score, objective_penalties, text_similarity
from cca_worker.selection import SelectionStage, merge_candidates, refine_bounds, user_prompt, validate_candidates
from cca_worker.units import build_units, padded_range

from tests.fake_app import FakeApp
from tests.fake_ollama import FakeOllama

FIXTURE = Path(__file__).parent / "fixtures" / "transcript_podcast_ficticio.json"
RATINGS = {"hook": 4, "clarity": 4, "value": 4, "standalone": 4, "pacing": 4}


def words(text: str, start: float, step: float = 0.4) -> list[dict]:
    return [{"word": w, "startSec": round(start + i * step, 3), "endSec": round(start + i * step + step - 0.05, 3)} for i, w in enumerate(text.split())]


def seg(text: str, start: float, step: float = 0.4) -> dict:
    ws = words(text, start, step)
    return {"startSec": ws[0]["startSec"], "endSec": ws[-1]["endSec"], "text": text, "words": ws}


def unit(text: str, start: float, end: float, kind: str) -> dict:
    return {"startSec": start, "endSec": end, "text": text, "words": [], "end": kind}


# Frases de um vídeo fictício; "split" = a frase continua na unidade seguinte.
UNITS = [
    unit("Bom dia.", 0.0, 2.0, "sentence"),
    unit("Hoje eu vou contar como perdi dinheiro numa aposta que parecia segura", 2.5, 20.0, "split"),
    unit("e no fim o cara sumiu com tudo.", 20.2, 24.0, "sentence"),
    unit("Porque ninguém desconfia de amigo.", 24.5, 27.0, "sentence"),
    unit("A lição é simples: desconfie de promessa fácil.", 27.3, 32.0, "sentence"),
    unit("Se inscreve no canal e deixa o like.", 32.5, 35.0, "sentence"),
    unit("Agora falando de outro assunto totalmente diferente aqui", 36.0, 50.0, "split"),
    unit("que continua.", 50.2, 52.0, "sentence"),
]


class UnitTests(unittest.TestCase):
    def test_sentences_cross_whisper_segments_and_pauses_close_units(self):
        segments = [seg("Ontem eu perdi", 0.0), seg("tudo na bolsa.", 1.3), seg("Foi horrível.", 2.6), seg("Mudando de assunto", 6.0)]
        units = build_units(segments)
        self.assertEqual([u["text"] for u in units], ["Ontem eu perdi tudo na bolsa.", "Foi horrível.", "Mudando de assunto"])
        self.assertEqual([u["end"] for u in units], ["sentence", "sentence", "pause"])
        # Os tempos são os das palavras, sem nada inventado.
        self.assertEqual((units[0]["startSec"], units[0]["endSec"]), (0.0, segments[1]["words"][-1]["endSec"]))

    def test_long_sentence_is_split_at_the_comma(self):
        text = " ".join(f"palavra{i}," if i == 24 else f"palavra{i}" for i in range(60)) + "."
        units = build_units([seg(text, 0.0)])
        self.assertGreater(len(units), 1)
        self.assertTrue(units[0]["text"].endswith("palavra24,"))
        self.assertEqual(units[0]["end"], "split")
        self.assertEqual(units[-1]["end"], "sentence")
        self.assertTrue(all(u["endSec"] - u["startSec"] <= 20.0 for u in units))
        self.assertEqual(" ".join(u["text"] for u in units), text, "nenhuma palavra se perde")

    def test_old_transcripts_without_words_still_work(self):
        units = build_units([{"startSec": 0.0, "endSec": 5.0, "text": "Sem palavras."}, {"startSec": 5.5, "endSec": 9.0, "text": "Outro trecho"}])
        self.assertEqual([(u["startSec"], u["endSec"], u["end"]) for u in units], [(0.0, 5.0, "sentence"), (5.5, 9.0, "pause")])

    def test_padding_never_invades_neighbor_speech_or_leaves_the_video(self):
        self.assertEqual(padded_range(UNITS, 3, 4, 60.0), (24.38, 32.3))
        self.assertEqual(padded_range(UNITS, 1, 1, 60.0), (2.38, 20.16), "fim limitado pela palavra seguinte (20,2 s)")
        self.assertEqual(padded_range(UNITS, 0, 0, 60.0)[0], 0.0)
        self.assertEqual(padded_range(UNITS, 7, 7, 52.1)[1], 52.1)


class RefineTests(unittest.TestCase):
    def test_start_in_the_middle_of_a_sentence_moves_to_its_beginning(self):
        s, e, notes = refine_bounds(UNITS, 2, 4, 15, 90)
        self.assertEqual((s, e), (1, 4))
        self.assertIn("Início movido para o começo da frase.", notes)

    def test_mid_sentence_start_moves_forward_when_the_whole_sentence_does_not_fit(self):
        s, _, notes = refine_bounds(UNITS, 2, 4, 5, 25)
        self.assertEqual(s, 3)
        self.assertIn("Início movido para a frase seguinte, que começa completa.", notes)

    def test_dependent_opener_brings_the_previous_sentence(self):
        s, _, notes = refine_bounds(UNITS, 3, 4, 5, 90)
        self.assertEqual(s, 1, "“Porque…” precisa do contexto: recua até o começo da frase anterior")
        self.assertTrue(any("porque" in n for n in notes))

    def test_call_to_action_is_trimmed_from_the_edges(self):
        _, e, notes = refine_bounds(UNITS, 1, 5, 15, 90)
        self.assertEqual(e, 4)
        self.assertIn("Vinheta ou pedido de inscrição removido do fim.", notes)

    def test_end_in_the_middle_of_a_sentence_extends_to_its_conclusion(self):
        _, e, notes = refine_bounds(UNITS, 4, 6, 15, 90)
        self.assertEqual(e, 7)
        self.assertIn("Fim estendido até a conclusão da frase.", notes)

    def test_unfixable_mid_sentence_end_is_flagged_and_capped(self):
        raw = [{"start_segment": 1, "end_segment": 1, "title": "Aposta", "hook": "como perdi dinheiro numa aposta", "reason": "r", "ratings": {k: 5 for k in CRITERIA}, "tags": []}]
        valid, rejected = validate_candidates(raw, UNITS, (0, 7), 60.0, 10, 20)
        self.assertEqual(rejected, [])
        a = valid[0]["analysis"]
        self.assertEqual(a["boundaries"], {"start": "sentence", "end": "mid"})
        self.assertEqual(a["criteria"]["pacing"], 2, "termina no meio da frase: ritmo e conclusão no máximo 2")
        self.assertTrue(any("meio de uma frase" in w for w in a["warnings"]))
        self.assertEqual(valid[0]["score"], final_score(a["criteria"], 0))


class GroundingTests(unittest.TestCase):
    def check(self, **kw):
        item = {"start_segment": 1, "end_segment": 4, "title": "A aposta que deu errado", "hook": "ninguém desconfia de amigo", "reason": "História completa.", "ratings": dict(RATINGS), "tags": ["golpe"]}
        item.update(kw)
        valid, rejected = validate_candidates([item], UNITS, (0, 7), 60.0, 15, 90)
        self.assertEqual(rejected, [])
        return valid[0]

    def test_hook_copied_from_the_speech_is_kept(self):
        clip = self.check()
        self.assertEqual(clip["hook"], "ninguém desconfia de amigo")
        self.assertEqual(clip["analysis"]["warnings"], [])

    def test_invented_hook_is_replaced_by_real_speech(self):
        clip = self.check(hook="Ele roubou cinquenta mil reais de mim!")
        self.assertIn(clip["hook"], [u["text"] for u in UNITS[1:5]], "o gancho passa a ser uma frase real do corte")
        self.assertTrue(any("gancho" in n for n in clip["analysis"]["adjustments"]))

    def test_paraphrased_hook_becomes_the_closest_real_sentence(self):
        clip = self.check(start_segment=4, end_segment=7, hook="Desconfie das promessas fáceis!", title="Lição")
        self.assertEqual(clip["hook"], "A lição é simples: desconfie de promessa fácil.")

    def test_title_with_numbers_not_in_the_speech_is_flagged(self):
        clip = self.check(title="Perdi 50 mil em 3 dias")
        self.assertTrue(any("número" in w for w in clip["analysis"]["warnings"]))

    def test_random_model_numbers_always_give_valid_ranges(self):
        transcript = json.loads(FIXTURE.read_text(encoding="utf-8"))
        units = build_units(transcript["segments"])
        duration = transcript["durationSec"]
        rng = random.Random(7)
        raw = [
            {"start_segment": rng.randint(-3, len(units) + 3), "end_segment": rng.randint(-3, len(units) + 3), "title": "t", "hook": "h h h", "reason": "r",
             "ratings": {k: rng.randint(-2, 8) for k in CRITERIA}, "tags": []}
            for _ in range(400)
        ]  # fmt: skip
        valid, rejected = validate_candidates(raw, units, (0, len(units) - 1), duration, 15, 90)
        self.assertTrue(valid and rejected)
        for c in valid:
            self.assertTrue(0 <= c["startSec"] < c["endSec"] <= duration, c)
            self.assertTrue(15 <= c["endSec"] - c["startSec"] <= 90, c)
            self.assertTrue(all(1 <= v <= 5 for v in c["analysis"]["criteria"].values()))
            # O corte começa no início de uma palavra real e termina depois da última palavra dita.
            first, last = c["segments"]
            self.assertLessEqual(c["startSec"], units[first]["startSec"])
            self.assertGreaterEqual(c["endSec"], units[last]["endSec"])


class ScoringTests(unittest.TestCase):
    # Os mesmos exemplos estão em tests/clip-analysis.test.ts (a aplicação refaz a conta).
    VECTORS = [
        ({k: 5 for k in CRITERIA}, 0, 100),
        ({k: 1 for k in CRITERIA}, 0, 0),
        ({"hook": 4, "clarity": 3, "value": 4, "standalone": 3, "pacing": 3}, 0, 63),
        ({"hook": 4, "clarity": 3, "value": 4, "standalone": 3, "pacing": 3}, 25, 55),
        ({"hook": 5, "clarity": 2, "value": 3, "standalone": 4, "pacing": 1}, 40, 42),
        ({k: 5 for k in CRITERIA}, 100, 70),
    ]

    def test_documented_weights_and_examples(self):
        self.assertEqual(sum(WEIGHTS.values()), 100)
        for criteria, redundancy, expected in self.VECTORS:
            self.assertEqual(final_score(criteria, redundancy), expected, (criteria, redundancy))

    def test_score_is_monotonic_in_each_criterion(self):
        for k in CRITERIA:
            low, high = dict(RATINGS), dict(RATINGS)
            low[k], high[k] = 2, 5
            self.assertGreater(final_score(high, 0), final_score(low, 0), k)

    def test_objective_rules_lower_inflated_ratings(self):
        screen = "Olha aqui, clica aqui nesse botão, aqui embaixo tem a tela de vendas e ali você vê o print. " * 3
        conversa = "Eu perdi trinta mil reais numa pirâmide financeira e aprendi a desconfiar de retorno garantido. " * 3
        self.assertEqual([c for c, _, _ in objective_penalties(screen)], ["standalone"])
        self.assertEqual(objective_penalties(screen)[0][1], 2)
        self.assertEqual(objective_penalties(conversa), [])
        fillers = "Então né, tipo, eu fui lá, entendeu, e aí, tipo, não deu, né, sabe como é. " * 3
        self.assertIn("pacing", [c for c, _, _ in objective_penalties(fillers)])
        units = [unit(screen, 0.0, 30.0, "sentence")]
        raw = [{"start_segment": 0, "end_segment": 0, "title": "t", "hook": "clica aqui nesse botão", "reason": "r", "ratings": {k: 5 for k in CRITERIA}, "tags": []}]
        valid, _ = validate_candidates(raw, units, (0, 0), 30.0, 15, 90)
        self.assertEqual(valid[0]["analysis"]["criteria"]["standalone"], 3)
        self.assertTrue(any(n.startswith("Autonomia −2") for n in valid[0]["analysis"]["adjustments"]))

    def test_text_similarity(self):
        self.assertGreater(text_similarity("Perdi trinta mil reais na pirâmide financeira", "A pirâmide financeira levou trinta mil reais"), 0.5)
        self.assertLess(text_similarity("Perdi trinta mil reais na pirâmide financeira", "Receita de bolo de cenoura com cobertura"), 0.1)
        self.assertEqual(text_similarity("", "algo"), 0.0)

    def test_final_clips_carry_a_reproducible_breakdown(self):
        valid, _ = validate_candidates(
            [{"start_segment": 1, "end_segment": 4, "title": "t", "hook": "ninguém desconfia de amigo", "reason": "r", "ratings": dict(RATINGS), "tags": []}], UNITS, (0, 7), 60.0, 15, 90
        )
        final = merge_candidates(valid, 5)
        a = final[0]["analysis"]
        self.assertEqual(set(a), {"version", "criteria", "redundancyPct", "boundaries", "adjustments", "warnings"})
        self.assertEqual(final[0]["score"], final_score(a["criteria"], a["redundancyPct"]))


class PromptTests(unittest.TestCase):
    def test_context_lines_have_no_number(self):
        prompt = user_prompt(UNITS, (3, 5), 0, 1)
        self.assertIn("entre [3] e [5]", prompt)
        self.assertIn("(contexto) Hoje eu vou contar", prompt)
        self.assertIn("(contexto) Agora falando", prompt)
        self.assertNotIn("[1]", prompt)
        self.assertNotIn("[6]", prompt)


class OllamaFailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="cca-quality-test-"))
        self.app = FakeApp().__enter__()
        self.ollama = FakeOllama().__enter__()
        env = {"CCA_APP_URL": self.app.url, "CCA_WORKER_TOKEN": self.app.token, "CCA_OLLAMA_URL": self.ollama.url, "CCA_WORKER_POLL_SECONDS": "1"}
        self.settings = load_settings(self.tmp, environ=env)
        self.api = WorkerApi(self.app.url, self.app.token)
        media = self.tmp / ".data" / "media" / "p_q"
        media.mkdir(parents=True)
        video = media / "source-q.mp4"
        video.write_bytes(b"x")
        segments = [{"id": i, "startSec": i * 6.0, "endSec": i * 6.0 + 5.6, "text": f"Frase número {i}."} for i in range(20)]
        (media / "transcript.json").write_text(json.dumps({"source": {"file": video.name}, "durationSec": 120.0, "segments": segments}), encoding="utf-8")
        self.app.add("p_q", "selecting", "media\\p_q\\source-q.mp4", str(video), duration=120.0)

    def tearDown(self):
        self.ollama.stop()
        self.app.__exit__()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_stage(self, timeout=10.0):
        stage = SelectionStage(self.settings, self.api, OllamaClient(self.settings.ollama_url, timeout=timeout))
        return run_loop(JobRunner(self.settings, self.api, None, stage), once=True)

    def test_timeout_is_retried_then_fails_with_clear_message(self):
        self.ollama.delay = 1.0
        outcomes = self.run_stage(timeout=0.3)
        self.assertEqual([o.result for o in outcomes], ["failed"])
        self.assertEqual(len(self.ollama.chats), 3, "três tentativas")
        error = self.app.projects["p_q"]["error"]
        self.assertEqual(error["stage"], "select")
        self.assertIn("demorou", error["message"])

    def test_timeout_message_from_the_client(self):
        self.ollama.delay = 1.0
        with self.assertRaises(OllamaError) as ctx:
            OllamaClient(self.ollama.url, timeout=0.3).chat_json("qwen2.5:7b", [{"role": "user", "content": "entre [0] e [1]"}], {}, {})
        self.assertIn("demorou", str(ctx.exception))

    def test_answers_without_ratings_are_rejected(self):
        self.ollama.reply = lambda body: json.dumps({"clips": [{"start_segment": 0, "end_segment": 4, "title": "t", "hook": "h", "reason": "r", "score": 99, "tags": []}]})
        self.run_stage()
        self.assertIn("Nenhum trecho adequado", self.app.projects["p_q"]["error"]["message"])


if __name__ == "__main__":
    unittest.main()
