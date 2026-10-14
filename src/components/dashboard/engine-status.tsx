import { CheckCircle2, CircleDashed, Workflow } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { PIPELINE_STAGES } from "@/lib/pipeline";
import { cn } from "@/lib/format";

/** Mostra com honestidade quais etapas do motor já existem. */
export function EngineStatus() {
  const ready = PIPELINE_STAGES.filter((s) => s.available).length;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader icon={<Workflow className="size-4" />} title="Status do motor" description={`${ready} de ${PIPELINE_STAGES.length} etapas disponíveis`} />
      <ol className="relative flex-1 space-y-0 px-5 py-4 sm:px-6">
        {PIPELINE_STAGES.map((stage, i) => (
          <li key={stage.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < PIPELINE_STAGES.length - 1 && <span className="absolute top-6 left-[9px] h-[calc(100%-18px)] w-px bg-white/[0.07]" aria-hidden />}
            <span className={cn("relative mt-0.5 shrink-0", stage.available ? "text-emerald-300" : "text-ink-500")}>
              {stage.available ? <CheckCircle2 className="size-[19px]" aria-hidden /> : <CircleDashed className="size-[19px]" aria-hidden />}
            </span>
            <div className="min-w-0">
              <p className={cn("text-sm font-medium", stage.available ? "text-white" : "text-ink-200")}>
                {stage.label}
                <span className="sr-only">{stage.available ? " (disponível)" : " (em desenvolvimento)"}</span>
              </p>
              <p className="mt-0.5 text-xs text-ink-400">{stage.available ? stage.engine : `Em breve · ${stage.engine}`}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
