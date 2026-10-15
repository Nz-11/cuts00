/**
 * Avaliação dos cortes por critério. A conta é a mesma de `worker/cca_worker/scoring.py`:
 *
 *   base  = soma(peso × (nota − 1) / 4) × 100      (notas de 1 a 5; pesos somam 100%)
 *   final = base − 30 × redundância                 (redundância de 0 a 100%)
 *
 * A aplicação refaz a conta ao receber os cortes do worker: a nota exibida é
 * sempre reproduzível a partir dos critérios. É uma estimativa editorial do
 * modelo local, não uma previsão de visualizações.
 */
import type { Clip, ClipAnalysis, ClipBoundary, ClipCriteria, ClipCriterion } from "./types";

export const CRITERIA: ClipCriterion[] = ["hook", "clarity", "value", "standalone", "pacing"];

/** Pesos em %. */
export const CRITERIA_WEIGHTS: Record<ClipCriterion, number> = { hook: 25, clarity: 20, value: 25, standalone: 15, pacing: 15 };
export const REDUNDANCY_PENALTY = 30;

export const CRITERIA_LABEL: Record<ClipCriterion, { title: string; description: string }> = {
  hook: { title: "Gancho", description: "Os primeiros segundos prendem a atenção?" },
  clarity: { title: "Clareza e contexto", description: "Dá para entender sem explicação extra?" },
  value: { title: "Valor", description: "Ensina, surpreende, emociona ou diverte?" },
  standalone: { title: "Autonomia", description: "Funciona sem o resto do vídeo?" },
  pacing: { title: "Ritmo e conclusão", description: "É direto e termina numa conclusão?" },
};

/** Nota mínima e posição máxima para um corte aparecer como recomendado. */
export const RECOMMENDED_MIN_SCORE = 60;
export const RECOMMENDED_TOP = 3;

const BOUNDARIES: ClipBoundary[] = ["sentence", "pause", "mid"];

export function computeScore(criteria: ClipCriteria, redundancyPct: number): number {
  const baseX4 = CRITERIA.reduce((sum, k) => sum + CRITERIA_WEIGHTS[k] * (criteria[k] - 1), 0);
  const value = Math.floor((25 * baseX4 - REDUNDANCY_PENALTY * redundancyPct + 50) / 100);
  return Math.max(0, Math.min(100, value));
}

/** Pontos que cada critério acrescenta à nota (para explicar a avaliação). */
export function contributions(analysis: ClipAnalysis): { key: ClipCriterion; points: number }[] {
  return CRITERIA.map((key) => ({ key, points: (CRITERIA_WEIGHTS[key] * (analysis.criteria[key] - 1)) / 4 }));
}

/** Critérios que mais pesaram a favor (nota 4 ou 5), do maior para o menor. */
export function strengths(analysis: ClipAnalysis): ClipCriterion[] {
  return contributions(analysis)
    .filter(({ key }) => analysis.criteria[key] >= 4)
    .sort((a, b) => b.points - a.points)
    .map(({ key }) => key);
}

export function weaknesses(analysis: ClipAnalysis): ClipCriterion[] {
  return CRITERIA.filter((k) => analysis.criteria[k] <= 2);
}

/** Ids dos cortes recomendados: os mais bem avaliados acima da nota mínima. */
export function recommendedIds(clips: { id: string; score: number; analysis?: ClipAnalysis }[]): Set<string> {
  const ranked = clips.filter((c) => c.analysis && c.score >= RECOMMENDED_MIN_SCORE).sort((a, b) => b.score - a.score);
  return new Set(ranked.slice(0, RECOMMENDED_TOP).map((c) => c.id));
}

function rating(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function notes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5 || !value.every((n) => typeof n === "string")) return null;
  return value.map((n: string) => n.slice(0, 200));
}

/** Valida a avaliação enviada pelo worker. `null` se estiver malformada. */
export function parseClipAnalysis(value: unknown): ClipAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const rawCriteria = raw.criteria as Record<string, unknown> | undefined;
  if (!rawCriteria || typeof rawCriteria !== "object") return null;
  const criteria = {} as ClipCriteria;
  for (const k of CRITERIA) {
    const r = rating(rawCriteria[k]);
    if (r === null) return null;
    criteria[k] = r;
  }
  const redundancyPct = raw.redundancyPct;
  if (typeof redundancyPct !== "number" || !Number.isInteger(redundancyPct) || redundancyPct < 0 || redundancyPct > 100) return null;
  const b = raw.boundaries as Record<string, unknown> | undefined;
  const start = b?.start as ClipBoundary;
  const end = b?.end as ClipBoundary;
  if (!BOUNDARIES.includes(start) || !BOUNDARIES.includes(end)) return null;
  const adjustments = notes(raw.adjustments);
  const warnings = notes(raw.warnings);
  if (!adjustments || !warnings) return null;
  return { version: 1, criteria, redundancyPct, boundaries: { start, end }, adjustments, warnings };
}

/** Valida a lista de cortes enviada pelo worker ao concluir a seleção. `undefined` se algo estiver malformado. */
export function parseWorkerClips(value: unknown): Clip[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const clips: Clip[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    const { id, title, startSec, endSec, score, reason, hook, transcript, tags } = raw ?? {};
    const valid =
      typeof id === "string" &&
      typeof title === "string" &&
      typeof startSec === "number" &&
      typeof endSec === "number" &&
      endSec > startSec &&
      startSec >= 0 &&
      typeof score === "number" &&
      typeof reason === "string" &&
      typeof hook === "string" &&
      typeof transcript === "string" &&
      Array.isArray(tags) &&
      tags.every((t) => typeof t === "string");
    if (!valid) return undefined;
    const clip: Clip = { id, title, startSec, endSec, score: Math.max(0, Math.min(100, score)), reason, hook, transcript, tags: tags as string[], decision: "pending" };
    if (raw.analysis !== undefined) {
      const analysis = parseClipAnalysis(raw.analysis);
      if (!analysis) return undefined;
      // A nota exibida é sempre a calculada pelos critérios (reproduzível).
      clip.analysis = analysis;
      clip.score = computeScore(analysis.criteria, analysis.redundancyPct);
    }
    clips.push(clip);
  }
  return clips;
}
