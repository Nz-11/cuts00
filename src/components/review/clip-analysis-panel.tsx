import { AlertTriangle, Gauge, Wand2 } from "lucide-react";
import { contributions, CRITERIA, CRITERIA_LABEL, CRITERIA_WEIGHTS, REDUNDANCY_PENALTY } from "@/lib/clip-analysis";
import { cn } from "@/lib/format";
import type { ClipAnalysis } from "@/lib/types";

/** Notas por critério, peso de cada um e de onde vem a pontuação final. */
export function CriteriaBreakdown({ analysis, score }: { analysis: ClipAnalysis; score: number }) {
  const parts = contributions(analysis);
  const base = parts.reduce((sum, p) => sum + p.points, 0);
  const penalty = (REDUNDANCY_PENALTY * analysis.redundancyPct) / 100;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-ink-200 uppercase">
        <Gauge className="size-3.5" aria-hidden /> Avaliação por critério
      </p>
      <dl className="mt-3 space-y-2.5">
        {CRITERIA.map((key) => {
          const value = analysis.criteria[key];
          const points = parts.find((p) => p.key === key)!.points;
          return (
            <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
              <dt className="min-w-0 text-sm text-ink-100" title={CRITERIA_LABEL[key].description}>
                {CRITERIA_LABEL[key].title} <span className="text-[11px] text-ink-500">· peso {CRITERIA_WEIGHTS[key]}%</span>
              </dt>
              <dd className="font-mono text-xs text-ink-300 tabular-nums">
                {value}/5 · +{formatPoints(points)}
              </dd>
              <dd className="col-span-2 flex gap-1" aria-label={`${CRITERIA_LABEL[key].title}: ${value} de 5`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} className={cn("h-1.5 flex-1 rounded-full", n <= value ? (value >= 4 ? "bg-emerald-400/80" : value <= 2 ? "bg-amber-400/80" : "bg-cyan-glow/70") : "bg-white/[0.07]")} />
                ))}
              </dd>
            </div>
          );
        })}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-t border-white/[0.05] pt-2.5">
          <dt className="text-sm text-ink-100" title="Semelhança, no tempo ou no assunto, com um corte mais bem avaliado">
            Redundância <span className="text-[11px] text-ink-500">· até −{REDUNDANCY_PENALTY} pts</span>
          </dt>
          <dd className="font-mono text-xs text-ink-300 tabular-nums">
            {analysis.redundancyPct}% · −{formatPoints(penalty)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
        {formatPoints(base)} − {formatPoints(penalty)} ={" "}
        {base - penalty === score ? (
          <span className="text-ink-300">{score} pts</span>
        ) : (
          <>
            {formatPoints(base - penalty)}, arredondado para <span className="text-ink-300">{score} pts</span>
          </>
        )}
        . Notas dadas pelo modelo local e conferidas por regras fixas. É uma estimativa editorial, não uma previsão de visualizações.
      </p>
    </div>
  );
}

/** Ajustes automáticos e pontos para conferir. */
export function AnalysisNotes({ analysis }: { analysis: ClipAnalysis }) {
  if (!analysis.adjustments.length && !analysis.warnings.length) return null;
  return (
    <div className="space-y-2">
      {analysis.warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {w}
        </p>
      ))}
      {analysis.adjustments.map((a) => (
        <p key={a} className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-400">
          <Wand2 className="mt-0.5 size-3.5 shrink-0 text-cyan-soft" aria-hidden /> {a}
        </p>
      ))}
    </div>
  );
}

function formatPoints(n: number) {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}
