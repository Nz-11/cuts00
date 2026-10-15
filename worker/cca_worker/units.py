"""Unidades de frase: a transcrição reorganizada em frases completas.

O Whisper divide a fala em trechos pelo tempo, não pelo sentido: num vídeo
real, só 1 em cada 4 trechos termina em ponto final. Se o modelo escolhesse
trechos do Whisper, os cortes começariam e terminariam no meio de frases.

Aqui as palavras (com os tempos reais do Whisper) são reagrupadas em
unidades que terminam onde a fala termina:
  - "sentence": a palavra termina com . ? ! ou …
  - "pause":    silêncio de pelo menos PAUSE_SEC antes da próxima palavra
  - "split":    frase longa demais, dividida na vírgula ou pausa mais forte
                (o corte NÃO deve terminar aqui: a frase continua)

Nenhum tempo é inventado: início e fim de cada unidade são os tempos da
primeira e da última palavra. Sem tempos por palavra (transcrições antigas),
o trecho inteiro vira uma unidade.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

PAUSE_SEC = 1.0
MAX_UNIT_SEC = 20.0
TERMINAL_RE = re.compile(r"[.?!…][\"'”’)\]]*$")
CLAUSE_RE = re.compile(r"[,;:—–][\"'”’)\]]*$")

# Folga nas bordas do corte: o Whisper marca o fim da última palavra um pouco
# cedo (a sílaba final some). A folga nunca invade a palavra vizinha.
LEAD_SEC = 0.12
TAIL_SEC = 0.30
NEIGHBOR_GAP_SEC = 0.04


def norm(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in plain if not unicodedata.combining(c))


def norm_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", norm(text))


def _segment_words(seg: dict[str, Any]) -> list[dict[str, Any]]:
    words = []
    for w in seg.get("words") or []:
        token = str(w.get("word", "")).strip()
        try:
            start, end = float(w["startSec"]), float(w["endSec"])
        except (KeyError, TypeError, ValueError):
            return []  # tempos quebrados: trata o trecho como um bloco só
        if token:
            words.append({"word": token, "startSec": start, "endSec": max(end, start)})
    return words


def build_units(segments: list[dict[str, Any]], max_unit_sec: float = MAX_UNIT_SEC, pause_sec: float = PAUSE_SEC) -> list[dict[str, Any]]:
    """Agrupa as palavras em frases. Cada unidade: startSec, endSec, text, words, end."""
    units: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    def close(kind: str) -> None:
        nonlocal current
        if current:
            units.append(_unit(current, kind))
            current = []

    for seg in segments:
        words = _segment_words(seg)
        if not words:
            # Sem tempos por palavra: o trecho é a menor unidade possível.
            close("pause")
            text = " ".join(str(seg.get("text", "")).split())
            if text:
                start, end = float(seg["startSec"]), float(seg["endSec"])
                kind = "sentence" if TERMINAL_RE.search(text) else "pause"
                units.append({"startSec": start, "endSec": end, "text": text, "words": [], "end": kind})
            continue
        for w in words:
            if current and w["startSec"] - current[-1]["endSec"] >= pause_sec:
                close("pause")
            current.append(w)
            if TERMINAL_RE.search(w["word"]):
                close("sentence")
            elif current[-1]["endSec"] - current[0]["startSec"] >= max_unit_sec:
                head, tail = _split_long(current)
                units.append(_unit(head, "split"))
                current = tail
    close("pause")
    return units


def _split_long(words: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Divide uma frase longa no ponto mais natural (vírgula e/ou pausa maior)."""
    best, best_score = len(words) - 1, -1.0
    for i in range(2, len(words) - 1):  # a primeira parte fica com pelo menos 3 palavras
        gap = words[i + 1]["startSec"] - words[i]["endSec"]
        score = gap + (0.5 if CLAUSE_RE.search(words[i]["word"]) else 0.0)
        if score > best_score:
            best, best_score = i, score
    return words[: best + 1], words[best + 1 :]


def _unit(words: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    return {
        "startSec": round(words[0]["startSec"], 3),
        "endSec": round(words[-1]["endSec"], 3),
        "text": " ".join(w["word"] for w in words),
        "words": words,
        "end": kind,
    }


def end_kind(unit: dict[str, Any]) -> str:
    """Como a unidade termina. Trechos do Whisper (sem `end`) são julgados pela pontuação."""
    kind = unit.get("end")
    if kind in ("sentence", "pause", "split"):
        return kind
    return "sentence" if TERMINAL_RE.search(str(unit.get("text", "")).strip()) else "pause"


def starts_clean(units: list[dict[str, Any]], i: int) -> bool:
    """A unidade `i` começa uma frase (a anterior terminou de verdade)?"""
    return i == 0 or end_kind(units[i - 1]) != "split"


def ends_clean(units: list[dict[str, Any]], i: int) -> bool:
    return i == len(units) - 1 or end_kind(units[i]) != "split"


def boundary_kind(units: list[dict[str, Any]], i: int, side: str) -> str:
    """Como o corte começa ("start") ou termina ("end") na unidade `i`: sentence, pause ou mid."""
    j = i - 1 if side == "start" else i
    if j < 0 or j >= len(units) - 1 and side == "end":
        return "sentence"
    kind = end_kind(units[j])
    return "mid" if kind == "split" else kind


def padded_range(units: list[dict[str, Any]], s: int, e: int, duration: float) -> tuple[float, float]:
    """Início e fim do corte com folga, sem invadir as palavras vizinhas."""
    start = units[s]["startSec"] - LEAD_SEC
    if s > 0:
        start = max(start, units[s - 1]["endSec"] + NEIGHBOR_GAP_SEC)
    end = units[e]["endSec"] + TAIL_SEC
    if e + 1 < len(units):
        end = min(end, units[e + 1]["startSec"] - NEIGHBOR_GAP_SEC)
    start = max(0.0, min(start, units[s]["startSec"]))
    end = min(duration, max(end, units[e]["endSec"]))
    return round(start, 2), round(end, 2)


# Palavras que, no começo de um corte, indicam continuação do que veio antes.
DEPENDENT_OPENERS = ("porque", "pois", "mas", "entao", "ai", "so que", "por isso", "alem disso", "tipo assim", "e ai", "e entao", "e por isso")
# Chamadas para ação e vinhetas: não acrescentam conteúdo ao corte.
CTA_RE = re.compile(
    r"\b(inscrev\w*|deixa (o|seu) like|deixe (o|seu) like|da (um|o) like|ativa (o|a) (sininho|notificac\w*)|sininho|link (na|da) descricao|"
    r"compartilh\w* (esse|este) video|comenta(e|r)? (ai|aqui) embaixo|ate o proximo video|valeu,? (galera|pessoal)|fala,? (galera|pessoal))\b"
)


def dependent_opener(text: str) -> str | None:
    plain = " ".join(norm_words(text)[:3])
    for opener in DEPENDENT_OPENERS:
        if plain == opener or plain.startswith(opener + " "):
            return opener
    return None


def is_cta(text: str) -> bool:
    return bool(CTA_RE.search(" ".join(norm_words(text))))
