"""Pontuação dos cortes: critérios separados, pesos fixos e conta reproduzível.

O modelo local dá uma nota de 1 a 5 para cada critério (com a régua descrita
no prompt). A redundância é medida pelo código, comparando cada corte com os
mais bem avaliados. A nota final (0–100) é sempre recalculável a partir de:

    base  = soma(peso × (nota − 1) / 4) × 100      (pesos somam 100%)
    final = base − 30 × redundância                 (redundância de 0 a 1)

A conta é feita em números inteiros (sem diferenças de arredondamento) e é
idêntica à de `src/lib/clip-analysis.ts`, que a refaz ao receber os cortes.
É uma estimativa de qualidade editorial, não uma previsão de visualizações.
"""

from __future__ import annotations

import re
from typing import Any

from .units import norm, norm_words

SCORE_VERSION = 1
CRITERIA = ("hook", "clarity", "value", "standalone", "pacing")
# Pesos em %: gancho e valor pesam mais (decidem se a pessoa fica); clareza
# vem em seguida; autonomia e ritmo completam.
WEIGHTS = {"hook": 25, "clarity": 20, "value": 25, "standalone": 15, "pacing": 15}
REDUNDANCY_PENALTY = 30
RATING_MIN, RATING_MAX = 1, 5
DUPLICATE_OVERLAP = 0.5  # mais da metade do mais curto em comum → mesmo corte
DUPLICATE_SIMILARITY = 0.5  # metade do vocabulário em comum → mesmo assunto repetido

assert sum(WEIGHTS.values()) == 100


def final_score(criteria: dict[str, int], redundancy_pct: int) -> int:
    base_x4 = sum(WEIGHTS[k] * (criteria[k] - RATING_MIN) for k in CRITERIA)  # base × 4
    value = (25 * base_x4 - REDUNDANCY_PENALTY * redundancy_pct + 50) // 100
    return max(0, min(100, value))


def base_score(criteria: dict[str, int]) -> int:
    return final_score(criteria, 0)


# ---------------------------------------------------------------------------
# Redundância

STOPWORDS = set(
    """
    a o as os um uma uns umas de da do das dos em na no nas nos por pra pro para com sem sobre entre ate
    e ou mas que se como quando onde porque pois entao ai la aqui isso isto esse essa este esta aquele aquela
    eu tu ele ela nos vos eles elas voce voces gente me te lhe nossa nosso sua seu suas seus minha meu
    ja nao sim mais menos muito muita muitos muitas tudo todo toda todos todas nada coisa coisas
    ser estar ter fazer vai vou foi era tem tinha tava esta estao sao sou fica ficar pode posso
    tipo assim ne entendeu sabe olha bom beleza cara gente pessoal agora hoje depois antes
    """.split()
)


def content_stems(text: str) -> set[str]:
    """Vocabulário de conteúdo: palavras com 4+ letras, sem as muito comuns, reduzidas a 6 letras."""
    return {w[:6] for w in norm_words(text) if len(w) >= 4 and w not in STOPWORDS}


def text_similarity(a: str, b: str) -> float:
    sa, sb = content_stems(a), content_stems(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def overlap_ratio(a: dict[str, Any], b: dict[str, Any]) -> float:
    inter = min(a["endSec"], b["endSec"]) - max(a["startSec"], b["startSec"])
    shorter = min(a["endSec"] - a["startSec"], b["endSec"] - b["startSec"])
    return max(0.0, inter) / shorter if shorter > 0 else 1.0


def rank_candidates(candidates: list[dict[str, Any]], max_clips: int) -> list[dict[str, Any]]:
    """Ordena pela nota base, descarta repetições e aplica a penalidade de redundância.

    Cada candidato precisa de startSec, endSec, transcript e analysis.criteria.
    Retorna até `max_clips` cortes, ordenados pela nota final.
    """
    ordered = sorted(candidates, key=lambda c: (-base_score(c["analysis"]["criteria"]), c["startSec"]))
    chosen: list[dict[str, Any]] = []
    for cand in ordered:
        overlap = max((overlap_ratio(cand, o) for o in chosen), default=0.0)
        similarity = max((text_similarity(cand["transcript"], o["transcript"]) for o in chosen), default=0.0)
        if overlap > DUPLICATE_OVERLAP or similarity >= DUPLICATE_SIMILARITY:
            continue
        redundancy_pct = int(round(100 * max(overlap, similarity)))
        analysis = {**cand["analysis"], "redundancyPct": redundancy_pct}
        chosen.append({**cand, "analysis": analysis, "score": final_score(analysis["criteria"], redundancy_pct)})
    chosen.sort(key=lambda c: (-c["score"], c["startSec"]))
    return chosen[:max_clips]


# ---------------------------------------------------------------------------
# Regras objetivas sobre o texto
#
# O modelo de 7B tende a dar notas altas para tudo. Estas regras, medidas no
# próprio texto do corte, reduzem a nota quando há um problema concreto:
#   - referências ao que aparece na tela ("aqui", "olha", "clicar"): no vídeo
#     vertical a tela quase não aparece → Autonomia −1 a partir de 5 por 100
#     palavras, −2 a partir de 8;
#   - muletas de fala ("né", "tipo", "entendeu"): Ritmo −1 a partir de 6 por
#     100 palavras.
# (Limites calibrados num vídeo real: cortes de conversa ficaram entre 1 e 3
# referências à tela por 100 palavras; o trecho de tutorial, 6,7.)

SCREEN_TERMS = ("aqui", "ali", "olha", "clica", "clicar", "clique", "tela", "print", "botao", "la em cima", "aqui embaixo", "voces estao vendo", "ta vendo")
FILLER_TERMS = ("ne", "tipo", "entendeu", "sabe", "enfim", "beleza", "e ai")
SCREEN_RATE_1, SCREEN_RATE_2, FILLER_RATE = 5.0, 8.0, 6.0


def term_rate(text: str, terms: tuple[str, ...]) -> float:
    """Ocorrências dos termos a cada 100 palavras."""
    words = norm_words(text)
    padded = " " + " ".join(words) + " "
    return 100 * sum(padded.count(f" {t} ") for t in terms) / max(1, len(words))


def objective_penalties(transcript: str) -> list[tuple[str, int, str]]:
    """(critério, redução, explicação) para cada regra objetiva que se aplica."""
    out: list[tuple[str, int, str]] = []
    screen = term_rate(transcript, SCREEN_TERMS)
    if screen >= SCREEN_RATE_1:
        cut = 2 if screen >= SCREEN_RATE_2 else 1
        out.append(("standalone", cut, f"Autonomia −{cut}: muitas referências ao que aparece na tela (“aqui”, “olha”, “clicar”): {screen:.1f} a cada 100 palavras."))
    fillers = term_rate(transcript, FILLER_TERMS)
    if fillers >= FILLER_RATE:
        out.append(("pacing", 1, f"Ritmo −1: muitas muletas de fala (“né”, “tipo”, “entendeu”): {fillers:.1f} a cada 100 palavras."))
    return out


# ---------------------------------------------------------------------------
# Fidelidade ao que foi dito

NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)*")


def numbers_in(text: str) -> set[str]:
    return {n.replace(".", "").replace(",", "") for n in NUMBER_RE.findall(text)}


def is_grounded_quote(quote: str, transcript: str) -> bool:
    """A frase aparece na fala? (aceita diferenças de acento, pontuação e caixa)."""
    words = norm_words(quote)
    if len(words) < 3:
        return False
    return " ".join(words) in " ".join(norm_words(transcript))


def ungrounded_numbers(text: str, transcript: str) -> set[str]:
    return numbers_in(norm(text)) - numbers_in(norm(transcript))
