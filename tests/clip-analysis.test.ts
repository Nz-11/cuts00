import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeScore, CRITERIA, CRITERIA_WEIGHTS, parseClipAnalysis, parseWorkerClips, recommendedIds, strengths, weaknesses } from "../src/lib/clip-analysis.ts";
import type { ClipAnalysis, ClipCriteria } from "../src/lib/types.ts";

const all = (n: number): ClipCriteria => ({ hook: n, clarity: n, value: n, standalone: n, pacing: n });

function analysis(overrides: Partial<ClipAnalysis> = {}): ClipAnalysis {
  return { version: 1, criteria: { hook: 4, clarity: 3, value: 4, standalone: 3, pacing: 3 }, redundancyPct: 0, boundaries: { start: "sentence", end: "sentence" }, adjustments: [], warnings: [], ...overrides };
}

describe("computeScore (mesma conta do worker)", () => {
  // Os mesmos exemplos estão em worker/tests/test_quality.py (ScoringTests.VECTORS).
  const vectors: [ClipCriteria, number, number][] = [
    [all(5), 0, 100],
    [all(1), 0, 0],
    [{ hook: 4, clarity: 3, value: 4, standalone: 3, pacing: 3 }, 0, 63],
    [{ hook: 4, clarity: 3, value: 4, standalone: 3, pacing: 3 }, 25, 55],
    [{ hook: 5, clarity: 2, value: 3, standalone: 4, pacing: 1 }, 40, 42],
    [all(5), 100, 70],
  ];
  it("reproduz os exemplos documentados", () => {
    assert.equal(Object.values(CRITERIA_WEIGHTS).reduce((a, b) => a + b, 0), 100);
    for (const [criteria, redundancy, expected] of vectors) assert.equal(computeScore(criteria, redundancy), expected, JSON.stringify(criteria));
  });
});

describe("parseClipAnalysis", () => {
  it("aceita uma avaliação completa", () => {
    assert.deepEqual(parseClipAnalysis(analysis({ adjustments: ["Início movido."] })), analysis({ adjustments: ["Início movido."] }));
  });

  it("recusa notas fora de 1–5, campos ausentes e tipos errados", () => {
    for (const bad of [
      null,
      "x",
      { ...analysis(), version: 2 },
      { ...analysis(), criteria: { ...analysis().criteria, hook: 6 } },
      { ...analysis(), criteria: { ...analysis().criteria, value: 2.5 } },
      { ...analysis(), criteria: { hook: 3 } },
      { ...analysis(), redundancyPct: 101 },
      { ...analysis(), redundancyPct: "0" },
      { ...analysis(), boundaries: { start: "meio", end: "sentence" } },
      { ...analysis(), warnings: "x" },
      { ...analysis(), adjustments: [1] },
    ]) {
      assert.equal(parseClipAnalysis(bad), null, JSON.stringify(bad));
    }
  });
});

describe("parseWorkerClips", () => {
  const base = { id: "c1", title: "T", startSec: 10, endSec: 40, score: 99, reason: "r", hook: "h", transcript: "t", tags: [] };

  it("recalcula a nota a partir dos critérios", () => {
    const clips = parseWorkerClips([{ ...base, analysis: analysis({ redundancyPct: 25 }) }]);
    assert.equal(clips?.[0].score, 55, "a nota enviada (99) é ignorada");
    assert.equal(clips?.[0].analysis?.redundancyPct, 25);
    assert.equal(clips?.[0].decision, "pending");
  });

  it("continua aceitando cortes sem avaliação (worker antigo)", () => {
    const clips = parseWorkerClips([base]);
    assert.equal(clips?.[0].score, 99);
    assert.equal(clips?.[0].analysis, undefined);
  });

  it("recusa avaliação malformada e timestamps inválidos", () => {
    assert.equal(parseWorkerClips([{ ...base, analysis: { criteria: {} } }]), undefined);
    assert.equal(parseWorkerClips([{ ...base, startSec: 50 }]), undefined);
    assert.equal(parseWorkerClips([{ ...base, startSec: -1 }]), undefined);
    assert.equal(parseWorkerClips([]), undefined);
  });
});

describe("explicação", () => {
  it("pontos fortes e fracos", () => {
    const a = analysis({ criteria: { hook: 5, clarity: 2, value: 4, standalone: 3, pacing: 1 } });
    assert.deepEqual(strengths(a), ["hook", "value"]);
    assert.deepEqual(weaknesses(a), ["clarity", "pacing"]);
    assert.equal(CRITERIA.length, 5);
  });

  it("recomenda até 3 cortes avaliados acima da nota mínima", () => {
    const clips = [
      { id: "a", score: 90, analysis: analysis() },
      { id: "b", score: 80, analysis: analysis() },
      { id: "c", score: 59, analysis: analysis() },
      { id: "d", score: 95 }, // corte antigo, sem avaliação por critério
      { id: "e", score: 70, analysis: analysis() },
      { id: "f", score: 65, analysis: analysis() },
    ];
    assert.deepEqual([...recommendedIds(clips)], ["a", "b", "e"]);
  });
});
