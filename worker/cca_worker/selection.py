"""Seleção de cortes com um modelo local (Ollama).

Fluxo de um projeto em `selecting`:
  1. Lê `.data/media/<id>/transcript.json` (gerado pela etapa de transcrição;
     nunca transcreve de novo) e reagrupa as palavras em frases (units.py).
  2. Divide as frases em janelas de alguns minutos, com sobreposição. Cada
     janela leva algumas frases vizinhas como contexto, sem número.
  3. Para cada janela, o modelo recebe as frases numeradas e responde, em
     JSON, com os NÚMEROS das frases de início e fim de cada corte e uma nota
     de 1 a 5 por critério. Os segundos vêm dos tempos das palavras: o modelo
     nunca escreve timestamps, então eles não podem ser inventados.
  4. Cada sugestão é validada e ajustada pelo código: começa e termina em
     frase completa, sem vinhetas nas pontas, com contexto quando abre com
     "porque", "mas"…, dentro do vídeo e da faixa de duração. O gancho
     precisa ser uma fala real do trecho.
  5. A pontuação final é calculada pelo código (scoring.py), com penalidade
     para cortes repetidos; quase-duplicatas são descartadas.
  6. O progresso de cada janela é salvo em `selection.json`. Ao reiniciar o
     worker, as janelas prontas são reaproveitadas e o resultado final não é
     duplicado.
  7. Os melhores cortes vão para a aplicação: `transition → review`.

Cada entrada em `selecting` é uma "rodada" (contada pelo histórico do
projeto). "Gerar novas sugestões" e "Tentar de novo" iniciam uma rodada nova,
com semente diferente; reiniciar o worker continua a rodada atual.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .api import AppUnreachable, JobGone, WorkerApi
from .config import Settings
from .ollama import OllamaClient, OllamaError, OllamaModelMissing, OllamaUnavailable
from .runner import TRANSCRIPT_FILE, JobOutcome, UnsafeJob, resolve_source, write_json_atomic
from .scoring import CRITERIA, RATING_MAX, RATING_MIN, SCORE_VERSION, base_score, is_grounded_quote, objective_penalties, rank_candidates, ungrounded_numbers
from .units import boundary_kind, build_units, dependent_opener, ends_clean, is_cta, norm_words, padded_range, starts_clean

log = logging.getLogger("cca_worker")

SELECTION_FILE = "selection.json"
SELECTION_VERSION = 1
PROMPT_VERSION = 5
MAX_ATTEMPTS = 3
CANDIDATES_PER_WINDOW = 3
CONTEXT_BEFORE, CONTEXT_AFTER = 3, 2  # frases de contexto (sem número) em volta da janela
LIMITS = {"title": 80, "hook": 140, "reason": 300, "tag": 24, "tags": 4, "transcript": 2000, "note": 140}
# Folga entre a soma dos tempos das frases e o máximo: as bordas ganham até
# LEAD_SEC + TAIL_SEC (units.py) e o corte final continua dentro do limite.
EDGE_MARGIN_SEC = 0.5


class InvalidModelOutput(Exception):
    pass


# ---------------------------------------------------------------------------
# Janelas e prompt


def build_windows(segments: list[dict[str, Any]], window_sec: float, overlap_sec: float) -> list[tuple[int, int]]:
    """Intervalos [primeiro, último] de índices de trechos, por tempo, com sobreposição."""
    if not segments:
        return []
    last_end = float(segments[-1]["endSec"])
    step = max(1.0, window_sec - overlap_sec)
    windows: list[tuple[int, int]] = []
    t = 0.0
    while True:
        idx = [i for i, s in enumerate(segments) if t <= float(s["startSec"]) < t + window_sec]
        if idx and (not windows or (idx[0], idx[-1]) != windows[-1]):
            # Uma janela contida na anterior não acrescenta nada.
            if not windows or idx[-1] > windows[-1][1]:
                windows.append((idx[0], idx[-1]))
        if t + window_sec >= last_end:
            return windows
        t += step


def fmt_ts(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def format_segments(segments: list[dict[str, Any]], first: int, last: int) -> str:
    return "\n".join(
        f"[{i}] {fmt_ts(segments[i]['startSec'])}-{fmt_ts(segments[i]['endSec'])} {segments[i]['text']}" for i in range(first, last + 1)
    )


def system_prompt(settings: Settings) -> str:
    return (
        "Você é um editor de vídeos curtos (YouTube Shorts, Reels e TikTok) especializado em conteúdo em português. "
        "Você recebe frases numeradas da transcrição de um vídeo longo, com o tempo de cada frase, e escolhe os "
        "melhores momentos para virarem cortes verticais independentes.\n\n"
        "Procure:\n"
        "- Histórias com começo, desenvolvimento e conclusão; opiniões fortes; curiosidades; humor; surpresas; explicações úteis.\n"
        "- Um começo que prenda nos primeiros segundos (pergunta, afirmação forte, surpresa, conflito, promessa).\n"
        "- Trechos que façam sentido para quem não viu o vídeo completo.\n\n"
        "Evite:\n"
        "- Começar com \"porque\", \"mas\", \"então\", \"isso\" ou outra referência ao que veio antes sem incluir esse contexto.\n"
        "- Terminar antes da conclusão da ideia.\n"
        "- Vinhetas, despedidas, pedidos de like ou inscrição, trechos repetitivos ou sem informação.\n"
        "- Dois cortes sobre a mesma coisa.\n"
        "- Cortes que mudem o sentido do que a pessoa disse.\n"
        f"- Duração fora de {settings.clip_min_sec} a {settings.clip_max_sec} segundos (confira pelos tempos das frases).\n\n"
        "Como trabalhar:\n"
        "1. Divida a conversa em blocos de assunto (cada história, dica, opinião ou piada é um bloco).\n"
        "2. O corte é o bloco inteiro: start_segment é a frase que introduz o assunto e end_segment é a frase que o conclui. "
        "Prefira o bloco mais curto que ainda conte a ideia completa.\n"
        "3. Linhas marcadas como contexto não têm número e não podem ser escolhidas: servem só para você entender a conversa.\n\n"
        "Para cada corte, responda:\n"
        "- start_segment e end_segment: números das frases (inclusive) onde o corte começa e termina.\n"
        "- start_quote: as primeiras 6 palavras da frase start_segment, copiadas exatamente.\n"
        "- end_quote: as últimas 6 palavras da frase end_segment, copiadas exatamente.\n"
        "- title: título curto e chamativo, em português (até 70 caracteres). Não cite números ou fatos que não estejam nas frases.\n"
        "- hook: a frase mais forte dos primeiros segundos do corte, COPIADA exatamente da transcrição (até 100 caracteres).\n"
        "- reason: por que este trecho funciona como corte, citando o que acontece nele (até 240 caracteres).\n"
        "- ratings: notas inteiras de 1 a 5, sendo 1 = fraco, 3 = razoável, 5 = excelente:\n"
        "  hook: os primeiros segundos fazem a pessoa querer continuar assistindo?\n"
        "  clarity: dá para entender sem explicação extra, com começo claro?\n"
        "  value: ensina algo, surpreende, emociona ou diverte de verdade?\n"
        "  standalone: funciona sozinho, sem depender do resto do vídeo?\n"
        "  pacing: é direto, sem enrolação, e termina numa conclusão?\n"
        "  Calibre as notas: 3 é um corte comum que funciona; 4 é claramente acima da média; 5 só para o melhor momento do vídeo "
        "naquele critério, raro. Se todos os cortes recebem 5, as notas não ajudam a escolher. Use 1 ou 2 sem receio.\n"
        "- tags: até 4 palavras-chave curtas, em minúsculas.\n\n"
        f"Escolha no máximo {CANDIDATES_PER_WINDOW} cortes. Se nenhum trecho for bom o bastante, responda com \"clips\": []. "
        "Use apenas o que está na transcrição: não invente fatos nem falas. Responda somente com JSON."
    )


def user_prompt(segments: list[dict[str, Any]], window: tuple[int, int], index: int, total: int) -> str:
    first, last = window
    parts = [
        f"Parte {index + 1} de {total} do vídeo ({fmt_ts(segments[first]['startSec'])} a {fmt_ts(segments[last]['endSec'])}). "
        f"Use apenas frases entre [{first}] e [{last}]."
    ]
    before = segments[max(0, first - CONTEXT_BEFORE) : first]
    if before:
        parts.append("Contexto anterior (não pode ser escolhido):\n" + "\n".join(f"(contexto) {s['text']}" for s in before))
    parts.append(format_segments(segments, first, last))
    after = segments[last + 1 : last + 1 + CONTEXT_AFTER]
    if after:
        parts.append("Contexto seguinte (não pode ser escolhido):\n" + "\n".join(f"(contexto) {s['text']}" for s in after))
    return "\n\n".join(parts)


RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_segment": {"type": "integer"},
                    "end_segment": {"type": "integer"},
                    "start_quote": {"type": "string"},
                    "end_quote": {"type": "string"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "reason": {"type": "string"},
                    "ratings": {
                        "type": "object",
                        "properties": {k: {"type": "integer", "minimum": RATING_MIN, "maximum": RATING_MAX} for k in CRITERIA},
                        "required": list(CRITERIA),
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["start_segment", "end_segment", "start_quote", "end_quote", "title", "hook", "reason", "ratings", "tags"],
            },
        }
    },
    "required": ["clips"],
}


# ---------------------------------------------------------------------------
# Leitura e validação da resposta


def parse_model_output(content: str) -> list[dict[str, Any]]:
    """Extrai a lista `clips` da resposta. Lança InvalidModelOutput se não for possível."""
    text = content.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as err:
        raise InvalidModelOutput(f"JSON inválido ({err.msg}).") from None
    if not isinstance(data, dict) or not isinstance(data.get("clips"), list):
        raise InvalidModelOutput("O JSON não tem a lista `clips`.")
    if not all(isinstance(c, dict) for c in data["clips"]):
        raise InvalidModelOutput("Itens de `clips` precisam ser objetos.")
    return data["clips"]


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    clean = " ".join(value.split())
    if not clean:
        return None
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


def _norm_words(text: str) -> list[str]:
    return norm_words(text)


def locate_quote(quote: Any, segments: list[dict[str, Any]], first: int, last: int, at_end: bool) -> int | None:
    """Índice da frase da janela cujo começo (ou fim) corresponde à citação.

    O modelo às vezes escreve o número de uma frase vizinha; a citação copiada
    do texto é mais confiável. Retorna None se nenhuma correspondência for boa.
    """
    if not isinstance(quote, str):
        return None
    words = _norm_words(quote)
    words = words[-8:] if at_end else words[:8]
    if len(words) < 2:
        return None
    target = " ".join(words)
    best, best_ratio = None, 0.0
    for i in range(first, last + 1):
        seg = _norm_words(str(segments[i]["text"]))
        part = seg[-len(words) :] if at_end else seg[: len(words)]
        ratio = difflib.SequenceMatcher(None, target, " ".join(part)).ratio()
        if ratio > best_ratio:
            best, best_ratio = i, ratio
    return best if best_ratio >= 0.8 else None


def _ratings(value: Any) -> dict[str, int] | None:
    """Notas de 1 a 5 de cada critério. Inteiros fora da faixa são limitados; o resto é inválido."""
    if not isinstance(value, dict):
        return None
    ratings: dict[str, int] = {}
    for key in CRITERIA:
        n = _int_value(value.get(key))
        if n is None:
            return None
        ratings[key] = max(RATING_MIN, min(RATING_MAX, n))
    return ratings


def _span(units: list[dict[str, Any]], a: int, b: int) -> float:
    return float(units[b]["endSec"]) - float(units[a]["startSec"])


def _clean_start(units: list[dict[str, Any]], s: int, e: int, max_sec: float) -> int:
    """Começo de frase mais próximo de `s`: de preferência voltando até 3 unidades
    (inclui a frase inteira), se couber na duração; senão, até 2 para frente."""
    if starts_clean(units, s):
        return s
    limit = max_sec - EDGE_MARGIN_SEC
    for i in range(s - 1, max(-1, s - 4), -1):
        if starts_clean(units, i) and _span(units, i, e) <= limit:
            return i
    for i in range(s + 1, min(e, s + 2) + 1):
        if starts_clean(units, i):
            return i
    return s


def _fit_end(units: list[dict[str, Any]], s: int, e: int, min_sec: float, max_sec: float) -> int:
    """Fim mais próximo do sugerido que caiba na duração, de preferência no fim de uma frase."""
    limit = max_sec - EDGE_MARGIN_SEC
    options = [j for j in range(s, min(len(units), e + 7)) if _span(units, s, j) <= limit]
    if not options:
        return e
    target = float(units[e]["endSec"])
    return min(options, key=lambda j: (_span(units, s, j) < min_sec, not ends_clean(units, j), abs(float(units[j]["endSec"]) - target)))


def refine_bounds(units: list[dict[str, Any]], s: int, e: int, min_sec: float, max_sec: float) -> tuple[int, int, list[str]]:
    """Ajusta as bordas de um corte para frases completas, sem vinhetas e com contexto."""
    notes: list[str] = []
    while s < e and is_cta(units[s]["text"]):
        s += 1
        notes.append("Vinheta ou pedido de inscrição removido do início.")
    while e > s and is_cta(units[e]["text"]):
        e -= 1
        notes.append("Vinheta ou pedido de inscrição removido do fim.")

    clean = _clean_start(units, s, e, max_sec)
    if clean != s:
        notes.append("Início movido para o começo da frase." if clean < s else "Início movido para a frase seguinte, que começa completa.")
        s = clean
    opener = dependent_opener(units[s]["text"])
    if opener and s > 0 and float(units[s]["startSec"]) - float(units[s - 1]["endSec"]) < 1.0:
        prev = _clean_start(units, s - 1, e, max_sec)
        if starts_clean(units, prev) and _span(units, prev, e) <= max_sec - EDGE_MARGIN_SEC:
            notes.append(f"Início recuado uma frase para dar contexto (começava com “{opener}”).")
            s = prev

    fitted = _fit_end(units, s, e, min_sec, max_sec)
    if fitted != e:
        if fitted > e:
            notes.append("Fim estendido até a conclusão da frase." if not ends_clean(units, e) else "Fim estendido para atingir a duração mínima.")
        else:
            notes.append("Fim antecipado para caber na duração máxima, no fim de uma frase." if ends_clean(units, fitted) else "Fim antecipado para caber na duração máxima.")
        e = fitted
    return s, e, list(dict.fromkeys(notes))


def validate_candidates(
    raw: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    window: tuple[int, int],
    duration_sec: float,
    min_sec: float,
    max_sec: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Converte as sugestões do modelo em cortes válidos.

    `segments` são as frases (units.build_units) ou, em transcrições sem
    tempos por palavra, os trechos do Whisper.

    Garantias de cada corte devolvido:
      0 <= startSec < endSec <= duration_sec e min_sec <= duração <= max_sec;
      título, gancho e justificativa preenchidos; gancho copiado da fala;
      notas de 1 a 5 em todos os critérios; score = scoring.base_score.
    Retorna (cortes válidos, motivos das rejeições).
    """
    first, last = window
    valid: list[dict[str, Any]] = []
    rejected: list[str] = []

    for n, item in enumerate(raw):
        s, e = _int_value(item.get("start_segment")), _int_value(item.get("end_segment"))
        if s is None or e is None:
            rejected.append(f"#{n}: frases ausentes ou não numéricas")
            continue
        # Conferência: a citação do começo precisa bater com o número da frase.
        # Divergência de 1 frase é corrigida pela citação (mais confiável); maior
        # que isso indica que o modelo misturou assuntos, e o corte é descartado.
        qs = locate_quote(item.get("start_quote"), segments, first, last, at_end=False)
        if qs is not None and qs != s:
            if abs(qs - s) > 1:
                rejected.append(f"#{n}: citação inicial é da frase [{qs}], mas o número indica [{s}]")
                continue
            s = qs
        # A citação do fim só corrige erros pequenos de numeração.
        qe = locate_quote(item.get("end_quote"), segments, first, last, at_end=True)
        if qe is not None and qe != e and abs(qe - e) <= 2 and qe >= s:
            e = qe
        if not (first <= s <= last and first <= e <= last):
            rejected.append(f"#{n}: frases [{s}]–[{e}] fora da janela [{first}]–[{last}]")
            continue
        if e < s:
            rejected.append(f"#{n}: fim [{e}] antes do início [{s}]")
            continue

        ratings = _ratings(item.get("ratings"))
        if ratings is None:
            rejected.append(f"#{n}: notas dos critérios ausentes ou não numéricas")
            continue

        s, e, adjustments = refine_bounds(segments, s, e, min_sec, max_sec)
        if float(segments[e]["endSec"]) > duration_sec + 1.0:  # 1 s de arredondamento do fim do áudio
            rejected.append(f"#{n}: termina em {segments[e]['endSec']}s, depois do fim do vídeo ({duration_sec}s)")
            continue
        start, end = padded_range(segments, s, e, duration_sec)
        length = end - start
        if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or length <= 0:
            rejected.append(f"#{n}: intervalo inválido {start}–{end}")
            continue
        if not (min_sec <= length <= max_sec):
            rejected.append(f"#{n}: duração {length:.1f}s fora de {min_sec}–{max_sec}s")
            continue

        title = _text(item.get("title"), LIMITS["title"])
        hook = _text(item.get("hook"), LIMITS["hook"])
        reason = _text(item.get("reason"), LIMITS["reason"])
        if not title or not hook or not reason:
            rejected.append(f"#{n}: título, gancho ou justificativa vazios")
            continue
        tags_raw = item.get("tags") if isinstance(item.get("tags"), list) else []
        tags: list[str] = []
        for t in tags_raw:
            tag = _text(t, LIMITS["tag"])
            if tag and tag.lower() not in tags:
                tags.append(tag.lower())
            if len(tags) == LIMITS["tags"]:
                break

        transcript = " ".join(str(segments[i]["text"]).strip() for i in range(s, e + 1))
        warnings: list[str] = []
        # O gancho aparece como fala da pessoa: precisa existir no trecho.
        if not is_grounded_quote(hook, transcript):
            hook = closest_sentence(hook, segments, s, e)
            adjustments.append("O gancho sugerido não era uma fala literal; foi trocado pela frase real mais parecida do início do corte.")
        if ungrounded_numbers(title, transcript):
            warnings.append("O título cita um número que não aparece na fala. Confira antes de publicar.")

        for criterion, cut, note in objective_penalties(transcript):
            ratings[criterion] = max(RATING_MIN, ratings[criterion] - cut)
            adjustments.append(note)

        boundaries = {"start": boundary_kind(segments, s, "start"), "end": boundary_kind(segments, e, "end")}
        # Regras fixas: um corte que começa ou termina no meio de uma frase não
        # pode ter nota alta em autonomia ou em ritmo e conclusão.
        if boundaries["start"] == "mid":
            ratings["standalone"] = min(ratings["standalone"], 2)
            warnings.append("Começa no meio de uma frase (não havia início completo por perto).")
        if boundaries["end"] == "mid":
            ratings["pacing"] = min(ratings["pacing"], 2)
            warnings.append("Termina no meio de uma frase (a frase passava da duração máxima).")

        analysis = {
            "version": SCORE_VERSION,
            "criteria": ratings,
            "redundancyPct": 0,
            "boundaries": boundaries,
            "adjustments": [a[: LIMITS["note"]] for a in adjustments][:5],
            "warnings": [w[: LIMITS["note"]] for w in warnings][:5],
        }
        valid.append(
            {
                "title": title,
                "startSec": start,
                "endSec": end,
                "score": base_score(ratings),
                "reason": reason,
                "hook": hook,
                "transcript": _text(transcript, LIMITS["transcript"]) or "",
                "tags": tags,
                "segments": [s, e],
                "analysis": analysis,
            }
        )
    return valid, rejected


HOOK_WINDOW_SEC = 15.0


def closest_sentence(hook: str, units: list[dict[str, Any]], s: int, e: int) -> str:
    """Frase real (dos primeiros segundos do corte) mais parecida com o gancho sugerido."""
    start = float(units[s]["startSec"])
    options = [i for i in range(s, e + 1) if float(units[i]["startSec"]) - start <= HOOK_WINDOW_SEC]
    target = " ".join(_norm_words(hook))

    def similarity(i: int) -> float:
        return difflib.SequenceMatcher(None, target, " ".join(_norm_words(str(units[i]["text"])))).ratio()

    full = [i for i in options if len(_norm_words(str(units[i]["text"]))) >= 4] or options
    best = max(full, key=lambda i: (similarity(i), -i))
    return _clip_text(str(units[best]["text"]), 100)


def _clip_text(text: str, limit: int) -> str:
    """Corta no fim de uma palavra, com reticências."""
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    return clean[: limit - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"


CLIP_FIELDS = ("title", "startSec", "endSec", "score", "reason", "hook", "transcript", "tags", "analysis")


def merge_candidates(candidates: list[dict[str, Any]], max_clips: int) -> list[dict[str, Any]]:
    """Remove repetições (tempo ou conteúdo), aplica a penalidade de redundância e fica com os melhores."""
    ranked = rank_candidates([c for c in candidates if isinstance(c.get("analysis"), dict)], max_clips)
    return [{"id": f"c{i + 1}", **{k: c[k] for k in CLIP_FIELDS}} for i, c in enumerate(ranked)]


# ---------------------------------------------------------------------------
# Persistência


def selection_key(transcript_bytes: bytes, settings: Settings, run: int) -> dict[str, Any]:
    return {
        "transcriptSha256": hashlib.sha256(transcript_bytes).hexdigest(),
        "model": settings.select_model,
        "promptVersion": PROMPT_VERSION,
        "run": run,
        "params": {
            "clipMinSec": settings.clip_min_sec,
            "clipMaxSec": settings.clip_max_sec,
            "maxClips": settings.max_clips,
            "windowSec": settings.window_sec,
            "overlapSec": settings.window_overlap_sec,
        },
    }


def load_selection(path: Path, key: dict[str, Any]) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if data.get("version") != SELECTION_VERSION or data.get("key") != key or not isinstance(data.get("windows"), dict):
        return None
    return data


def selection_run(project: dict[str, Any]) -> int:
    """Número da rodada: quantas vezes o projeto entrou em `selecting`."""
    return sum(1 for h in project.get("history") or [] if isinstance(h, dict) and h.get("status") == "selecting") or 1


# ---------------------------------------------------------------------------
# Etapa


class SelectionStage:
    def __init__(self, settings: Settings, api: WorkerApi, ollama: OllamaClient):
        self.settings = settings
        self.api = api
        self.ollama = ollama

    def check_ready(self) -> str | None:
        """None se o Ollama e o modelo estão prontos; senão, o motivo."""
        try:
            if not self.ollama.has_model(self.settings.select_model):
                return f"o modelo '{self.settings.select_model}' não está no Ollama (rode: ollama pull {self.settings.select_model})"
        except OllamaUnavailable as err:
            return f"{err}. Abra o Ollama"
        except OllamaError as err:
            return str(err)
        return None

    def process(self, job: dict[str, Any]) -> JobOutcome:
        project_id = str(job.get("projectId") or "?")
        try:
            source = resolve_source(self.settings, job)
        except UnsafeJob as err:
            return self._fail(project_id, f"Arquivo de mídia inválido: {err}.", "select")

        transcript_path = source.parent / TRANSCRIPT_FILE
        try:
            transcript_bytes = transcript_path.read_bytes()
            transcript = json.loads(transcript_bytes.decode("utf-8"))
            segments = transcript["segments"]
            if not isinstance(segments, list):
                raise ValueError
        except (OSError, ValueError, KeyError, UnicodeDecodeError):
            return self._fail(project_id, "A transcrição deste projeto não foi encontrada ou está corrompida. Use “Tentar transcrever de novo”.", "transcribe")
        if (transcript.get("source") or {}).get("file") != source.name:
            return self._fail(project_id, "A transcrição salva é de outro arquivo. Use “Tentar transcrever de novo”.", "transcribe")

        try:
            claimed = self.api.progress(project_id, 0.02, f"Preparando a seleção de cortes ({self.settings.select_model})")
        except JobGone as err:
            log.info("Projeto %s mudou antes da seleção (%s); ignorado.", project_id, err)
            return JobOutcome(project_id, "skipped", str(err))
        if claimed.get("status") != "selecting":
            return JobOutcome(project_id, "skipped", "projeto alterado")

        media_duration = (job.get("media") or {}).get("durationSec")
        duration = float(media_duration or transcript.get("durationSec") or 0)
        if duration <= 0:
            return self._fail(project_id, "Duração do vídeo desconhecida.", "select")
        if duration < self.settings.clip_min_sec:
            return self._fail(project_id, f"O vídeo tem {duration:.0f} s, menos que a duração mínima de um corte ({self.settings.clip_min_sec} s).", "select")

        run = selection_run(claimed)
        key = selection_key(transcript_bytes, self.settings, run)
        path = source.parent / SELECTION_FILE
        state = load_selection(path, key)
        if state is None:
            state = {"version": SELECTION_VERSION, "projectId": project_id, "key": key, "createdAt": _now(), "windows": {}}

        try:
            if state.get("final") is not None:
                log.info("Projeto %s: seleção da rodada %d já estava pronta; reaproveitando.", project_id, run)
                return self._finish(project_id, state["final"], reused=True)
            return self._run(project_id, build_units(segments), duration, run, state, path)
        except JobGone as err:
            log.info("Projeto %s foi excluído ou alterado durante a seleção (%s); cancelado.", project_id, err)
            return JobOutcome(project_id, "cancelled", str(err))
        except AppUnreachable as err:
            log.warning("Projeto %s: a aplicação parou de responder (%s). Será retomado.", project_id, err)
            return JobOutcome(project_id, "interrupted", str(err))
        except (OllamaUnavailable, OllamaModelMissing) as err:
            log.warning("Projeto %s: %s. A seleção continua quando o Ollama voltar.", project_id, err)
            try:
                self.api.progress(project_id, _progress(state), "Ollama indisponível — a seleção continua quando ele voltar")
            except (JobGone, AppUnreachable):
                pass
            return JobOutcome(project_id, "interrupted", str(err))
        except MemoryError:
            return self._fail(project_id, "Memória insuficiente durante a seleção. Feche outros programas ou use um modelo menor (CCA_SELECT_MODEL).", "select")
        except OSError as err:
            return self._fail(project_id, f"Erro de arquivo durante a seleção: {err.strerror or err}.", "select")

    def _run(self, project_id: str, units: list[dict[str, Any]], duration: float, run: int, state: dict[str, Any], path: Path) -> JobOutcome:
        s = self.settings
        windows = build_windows(units, s.window_sec, s.window_overlap_sec)
        if not windows:
            return self._fail(project_id, "A transcrição não tem trechos de fala para analisar.", "select")
        state["windowCount"] = len(windows)
        log.info("Projeto %s: seleção (rodada %d) em %d parte(s) com %s.", project_id, run, len(windows), s.select_model)

        for index, window in enumerate(windows):
            done = state["windows"].get(str(index))
            if done and done.get("status") == "done" and done.get("range") == list(window):
                continue
            self.api.progress(project_id, _progress(state), f"Analisando parte {index + 1} de {len(windows)} ({s.select_model})")
            result = self._ask(units, window, index, len(windows), duration, run)
            state["windows"][str(index)] = result
            state["updatedAt"] = _now()
            write_json_atomic(path, state)
            log.info(
                "Projeto %s: parte %d/%d → %d corte(s) válido(s), %d rejeitado(s)%s.",
                project_id, index + 1, len(windows), len(result["candidates"]), len(result["rejected"]),
                f", erro: {result['error']}" if result.get("error") else "",
            )  # fmt: skip

        results = [state["windows"][str(i)] for i in range(len(windows))]
        if all(r["status"] == "error" for r in results):
            last_error = results[-1].get("error") or "respostas inválidas"
            return self._fail(project_id, f"O modelo local não gerou respostas válidas ({last_error}). Tente de novo.", "select")
        candidates = [c for r in results for c in r["candidates"]]
        final = merge_candidates(candidates, s.max_clips)
        if not final:
            return self._fail(
                project_id,
                f"Nenhum trecho adequado foi encontrado (duração entre {s.clip_min_sec} e {s.clip_max_sec} s). Tente de novo ou ajuste CCA_CLIP_MIN_SEC/CCA_CLIP_MAX_SEC.",
                "select",
            )

        self.api.progress(project_id, 0.99, "Salvando as sugestões")
        state["final"] = final
        state["completedAt"] = _now()
        write_json_atomic(path, state)
        return self._finish(project_id, final, reused=False)

    def _ask(self, segments: list[dict[str, Any]], window: tuple[int, int], index: int, total: int, duration: float, run: int) -> dict[str, Any]:
        s = self.settings
        messages = [{"role": "system", "content": system_prompt(s)}, {"role": "user", "content": user_prompt(segments, window, index, total)}]
        last_error = ""
        for attempt in range(1, MAX_ATTEMPTS + 1):
            options = {"temperature": 0.4 if attempt == 1 else 0.7, "seed": run * 1000 + index * 10 + attempt, "num_ctx": s.select_num_ctx, "num_predict": 2500}
            try:
                content = self.ollama.chat_json(s.select_model, messages, RESPONSE_SCHEMA, options)
                raw = parse_model_output(content)
            except (OllamaUnavailable, OllamaModelMissing):
                raise
            except (OllamaError, InvalidModelOutput) as err:
                last_error = str(err)
                log.warning("Parte %d, tentativa %d/%d: %s", index + 1, attempt, MAX_ATTEMPTS, err)
                continue
            valid, rejected = validate_candidates(raw, segments, window, duration, s.clip_min_sec, s.clip_max_sec)
            for reason in rejected:
                log.debug("Parte %d: sugestão rejeitada %s", index + 1, reason)
            return {"status": "done", "range": list(window), "attempts": attempt, "candidates": valid, "rejected": rejected}
        return {"status": "error", "range": list(window), "attempts": MAX_ATTEMPTS, "candidates": [], "rejected": [], "error": last_error[:300]}

    def _finish(self, project_id: str, clips: list[dict[str, Any]], reused: bool) -> JobOutcome:
        note = f"{len(clips)} corte(s) sugerido(s) pelo modelo local {self.settings.select_model}" + (" — reaproveitados" if reused else "")
        try:
            self.api.transition(project_id, "review", clips=clips, note=note)
        except JobGone as err:
            log.info("Projeto %s mudou antes da conclusão da seleção (%s).", project_id, err)
            return JobOutcome(project_id, "cancelled", str(err))
        log.info("Projeto %s → revisão. %s", project_id, note)
        return JobOutcome(project_id, "reused" if reused else "completed", note)

    def _fail(self, project_id: str, message: str, stage: str) -> JobOutcome:
        log.error("Projeto %s falhou na seleção: %s", project_id, message)
        try:
            self.api.transition(project_id, "failed", error={"stage": stage, "message": message})
        except JobGone as err:
            log.info("Projeto %s já tinha mudado (%s).", project_id, err)
        except AppUnreachable as err:
            log.warning("Não foi possível registrar a falha de %s (%s).", project_id, err)
            return JobOutcome(project_id, "interrupted", message)
        return JobOutcome(project_id, "failed", message)


def _progress(state: dict[str, Any]) -> float:
    total = state.get("windowCount") or 0
    done = sum(1 for w in state.get("windows", {}).values() if w.get("status") in ("done", "error"))
    return 0.02 + 0.95 * (done / total) if total else 0.02


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
