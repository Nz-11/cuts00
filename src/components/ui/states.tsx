import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export function EmptyState({ icon, title, description, action, className }: { icon: ReactNode; title: string; description: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      <div className="relative mb-5">
        <div className="absolute inset-0 rounded-2xl bg-violet-glow/30 blur-2xl" aria-hidden />
        <div className="relative grid size-14 place-items-center rounded-2xl border border-white/10 bg-ink-800 text-violet-soft">{icon}</div>
      </div>
      <h3 className="font-display text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-300">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Algo deu errado", description, action }: { title?: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-5 grid size-14 place-items-center rounded-2xl border border-rose-400/20 bg-rose-500/10 text-rose-300">
        <AlertTriangle className="size-6" aria-hidden />
      </div>
      <h3 className="font-display text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-300">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "info", title, children, icon }: { tone?: "info" | "warning"; title?: string; children: ReactNode; icon?: ReactNode }) {
  const styles = tone === "warning" ? "border-amber-400/20 bg-amber-400/[0.06] text-amber-100/90" : "border-cyan-glow/20 bg-cyan-glow/[0.05] text-cyan-50/90";
  const iconColor = tone === "warning" ? "text-amber-300" : "text-cyan-soft";
  return (
    <div className={cn("flex gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed", styles)}>
      <span className={cn("mt-0.5 shrink-0", iconColor)}>{icon ?? (tone === "warning" ? <AlertTriangle className="size-4" /> : <Info className="size-4" />)}</span>
      <div>
        {title && <p className="font-medium text-white">{title}</p>}
        <div className={cn(title && "mt-0.5", "text-ink-200")}>{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-lg", className)} aria-hidden />;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 animate-fade-up">
        {eyebrow && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-ink-300">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-[32px] sm:leading-tight">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-300">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 animate-fade-up">{actions}</div>}
    </header>
  );
}
