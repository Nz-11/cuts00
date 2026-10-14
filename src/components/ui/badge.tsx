import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/project-status";
import type { JobInfo, ProjectStatus } from "@/lib/types";

type Tone = "neutral" | "violet" | "cyan" | "green" | "amber" | "rose";

const tones: Record<Tone, string> = {
  neutral: "bg-white/[0.05] text-ink-200 ring-white/10",
  violet: "bg-violet-glow/10 text-violet-soft ring-violet-glow/25",
  cyan: "bg-cyan-glow/10 text-cyan-soft ring-cyan-glow/25",
  green: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
  amber: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
  rose: "bg-rose-400/10 text-rose-300 ring-rose-400/25",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

/** Identifica explicitamente conteúdo com dados fictícios. */
export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge tone="amber" className={className}>
      <FlaskConical className="size-3" aria-hidden />
      Dados fictícios
    </Badge>
  );
}

const STATUS_TONE: Record<ProjectStatus, Tone> = {
  awaiting_source: "neutral",
  transcribing: "cyan",
  selecting: "cyan",
  review: "violet",
  rendering: "cyan",
  completed: "green",
  failed: "rose",
};

export function StatusBadge({ status, job }: { status: ProjectStatus; job?: JobInfo }) {
  const live = job?.state === "running";
  return (
    <Badge tone={STATUS_TONE[status]}>
      <span className={cn("size-1.5 rounded-full bg-current", live && "animate-pulse")} aria-hidden />
      {STATUS_LABEL[status]}
      {job && <span className="opacity-70">· {job.state === "queued" ? "na fila" : `${Math.round(job.progress * 100)}%`}</span>}
    </Badge>
  );
}
