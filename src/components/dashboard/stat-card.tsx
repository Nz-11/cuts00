import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function StatCard({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon: ReactNode }) {
  return (
    <Card interactive className="overflow-hidden p-5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-300">{label}</span>
        <span className="grid size-8 place-items-center rounded-lg bg-white/[0.04] text-violet-soft ring-1 ring-white/[0.06]">{icon}</span>
      </div>
      <div className="mt-4">
        <div className="font-display text-[28px] leading-none font-semibold tracking-tight text-white tabular-nums">{value}</div>
        {hint && <p className="mt-2 text-xs text-ink-400">{hint}</p>}
      </div>
    </Card>
  );
}
