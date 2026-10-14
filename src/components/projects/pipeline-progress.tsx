import { Check, CircleDashed, Clock, Hand, Loader2, X } from "lucide-react";
import { cn } from "@/lib/format";
import { PIPELINE_STAGES } from "@/lib/pipeline";
import { STATUS_STAGE } from "@/lib/project-status";
import type { Project } from "@/lib/types";

type StepState = "done" | "running" | "queued" | "action" | "failed" | "upcoming";

function stepStates(project: Pick<Project, "status" | "job" | "error">): StepState[] {
  const { status, job, error } = project;
  if (status === "completed") return PIPELINE_STAGES.map(() => "done");
  const currentStage = status === "failed" ? (error?.stage ?? "ingest") : STATUS_STAGE[status];
  const current = PIPELINE_STAGES.findIndex((s) => s.id === currentStage);

  return PIPELINE_STAGES.map((_, i) => {
    if (i < current) return "done";
    if (i > current) return "upcoming";
    if (status === "failed") return "failed";
    if (status === "awaiting_source" || status === "review") return "action";
    return job?.state === "running" ? "running" : "queued";
  });
}

const STATE_LABEL: Record<StepState, string> = {
  done: "Concluído",
  running: "Em andamento",
  queued: "Na fila",
  action: "Aguardando você",
  failed: "Falhou",
  upcoming: "Pendente",
};

export function PipelineProgress({ project }: { project: Pick<Project, "status" | "job" | "error"> }) {
  const states = stepStates(project);
  return (
    <ol className="grid gap-3 sm:grid-cols-5 sm:gap-2">
      {PIPELINE_STAGES.map((stage, i) => {
        const state = states[i];
        return (
          <li key={stage.id} className="relative flex gap-3 sm:flex-col sm:gap-0">
            <div className="relative flex items-center sm:mb-4">
              <span
                className={cn(
                  "relative z-10 grid size-9 shrink-0 place-items-center rounded-full border transition-colors",
                  state === "done" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
                  state === "running" && "animate-pulse-ring border-cyan-glow/40 bg-cyan-glow/10 text-cyan-soft",
                  state === "queued" && "border-cyan-glow/30 bg-cyan-glow/[0.06] text-cyan-soft",
                  state === "action" && "border-violet-glow/40 bg-violet-glow/10 text-violet-soft",
                  state === "failed" && "border-rose-400/40 bg-rose-500/10 text-rose-300",
                  state === "upcoming" && "border-white/10 bg-ink-800 text-ink-500",
                )}
              >
                {state === "done" ? (
                  <Check className="size-4" aria-hidden />
                ) : state === "running" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : state === "queued" ? (
                  <Clock className="size-4" aria-hidden />
                ) : state === "action" ? (
                  <Hand className="size-4" aria-hidden />
                ) : state === "failed" ? (
                  <X className="size-4" aria-hidden />
                ) : (
                  <CircleDashed className="size-4" aria-hidden />
                )}
              </span>
              {i < PIPELINE_STAGES.length - 1 && (
                <span className={cn("absolute top-1/2 left-9 hidden h-px w-[calc(100%-1.75rem)] sm:block", state === "done" ? "bg-gradient-to-r from-emerald-400/50 to-emerald-400/20" : "bg-white/[0.08]")} aria-hidden />
              )}
            </div>
            <div className="min-w-0 pr-2">
              <p className="text-sm font-medium text-white">{stage.label}</p>
              <p className={cn("mt-0.5 text-xs", state === "failed" ? "text-rose-300" : state === "running" || state === "queued" ? "text-cyan-soft" : state === "action" ? "text-violet-soft" : "text-ink-400")}>
                {STATE_LABEL[state]}
                {state === "running" && project.job ? ` · ${Math.round(project.job.progress * 100)}%` : ""}
              </p>
              {!stage.available && <p className="mt-1 text-[11px] text-ink-500">Motor em desenvolvimento</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
