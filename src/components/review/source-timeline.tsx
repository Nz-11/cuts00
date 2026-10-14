import { cn, formatTimecode } from "@/lib/format";
import type { Clip } from "@/lib/types";

/** Linha do tempo do vídeo-fonte com a posição de todos os cortes sugeridos. */
export function SourceTimeline({ clips, durationSec, selectedId, onSelect }: { clips: Clip[]; durationSec: number; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <div>
      <div className="relative h-10 rounded-lg border border-white/[0.06] bg-ink-900">
        {/* waveform decorativa */}
        <div className="absolute inset-x-2 inset-y-2 flex items-center gap-[2px] opacity-30" aria-hidden>
          {Array.from({ length: 80 }, (_, i) => (
            <span key={i} className="flex-1 rounded-full bg-ink-300" style={{ height: `${20 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6)) * 80}%` }} />
          ))}
        </div>
        {clips.map((clip) => {
          const left = (clip.startSec / durationSec) * 100;
          const width = Math.max(((clip.endSec - clip.startSec) / durationSec) * 100, 0.8);
          const selected = clip.id === selectedId;
          return (
            <button
              key={clip.id}
              type="button"
              onClick={() => onSelect(clip.id)}
              aria-label={`Selecionar corte ${clip.title} (${formatTimecode(clip.startSec)})`}
              className={cn(
                "absolute inset-y-1 rounded-md border transition-all duration-300",
                selected ? "z-10 border-cyan-soft bg-cyan-glow/35 shadow-[0_0_16px_rgb(34_211_238/0.6)]" : "border-violet-soft/40 bg-violet-glow/25 hover:bg-violet-glow/45",
                clip.decision === "rejected" && !selected && "opacity-35",
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-ink-500">
        <span>00:00</span>
        <span>{formatTimecode(durationSec / 2)}</span>
        <span>{formatTimecode(durationSec)}</span>
      </div>
    </div>
  );
}
