import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/format";

export function Card({ interactive, className, ...props }: { interactive?: boolean } & ComponentProps<"div">) {
  return <div className={cn("surface rounded-2xl", interactive && "surface-interactive", className)} {...props} />;
}

export function CardHeader({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.05] px-5 py-4 sm:px-6">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-violet-soft ring-1 ring-white/[0.06]">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold tracking-tight text-white">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-300">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
