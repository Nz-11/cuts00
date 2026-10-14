import { Minus, Plus } from "lucide-react";
import { formatTimecode } from "@/lib/format";

/** Ajuste fino de um ponto de corte (início ou fim) em passos de 0,5 s. */
export function TrimControl({ id, label, value, min, max, onChange }: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v * 2) / 2));
  const nudgeClass =
    "grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-ink-200 transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-white disabled:opacity-40";

  return (
    <div className="rounded-xl border border-white/[0.06] bg-ink-900/60 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-ink-300">
          {label}
        </label>
        <span className="font-mono text-sm text-white tabular-nums">{formatTimecode(value)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={nudgeClass} onClick={() => onChange(clamp(value - 0.5))} disabled={value <= min} aria-label={`${label}: recuar 0,5 segundo`}>
          <Minus className="size-4" aria-hidden />
        </button>
        <input
          id={id}
          type="number"
          step={0.5}
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onChange(clamp(v));
          }}
          className="h-9 w-full min-w-0 rounded-lg border border-white/10 bg-ink-950 px-2 text-center font-mono text-sm text-white tabular-nums focus:border-violet-glow/60 focus:outline-none focus:ring-2 focus:ring-violet-glow/20"
        />
        <button type="button" className={nudgeClass} onClick={() => onChange(clamp(value + 0.5))} disabled={value >= max} aria-label={`${label}: avançar 0,5 segundo`}>
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
      <p className="mt-1.5 text-center text-[10px] text-ink-500">segundos no vídeo-fonte</p>
    </div>
  );
}
