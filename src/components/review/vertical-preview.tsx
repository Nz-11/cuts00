import { Captions, Play } from "lucide-react";
import { cn } from "@/lib/format";
import type { CaptionStyle } from "@/lib/types";

const FONT: Record<CaptionStyle["fontFamily"], string> = {
  Sora: "var(--font-sora)",
  Geist: "var(--font-geist-sans)",
  Impact: "Impact, 'Arial Narrow Bold', sans-serif",
};

/** Prévia ilustrativa de um corte 9:16 com o estilo de legenda configurado. */
export function VerticalPreview({ caption, text, className }: { caption: CaptionStyle; text: string; className?: string }) {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6);
  const highlight = Math.min(2, words.length - 1);
  // A prévia tem ~1/4 da largura de 1080px: escala o tamanho configurado.
  const fontSize = Math.round(caption.fontSize * 0.36);

  return (
    <div className={cn("relative aspect-[9/16] overflow-hidden rounded-[22px] border border-white/10 bg-ink-900 shadow-[0_30px_80px_-30px_rgb(139_92_246/0.5)]", className)}>
      <div className="absolute inset-0 bg-[radial-gradient(90%_60%_at_30%_20%,rgb(139_92_246/0.35),transparent_60%),radial-gradient(80%_50%_at_80%_90%,rgb(34_211_238/0.22),transparent_60%)]" aria-hidden />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3 text-[10px] font-medium text-white/70">
        <span className="rounded-full bg-black/40 px-2 py-0.5 backdrop-blur">9:16 · 1080×1920</span>
        <Captions className="size-3.5" aria-hidden />
      </div>
      <div className="absolute inset-0 grid place-items-center">
        <span className="grid size-12 place-items-center rounded-full border border-white/20 bg-white/10 text-white/80 backdrop-blur">
          <Play className="ml-0.5 size-5" aria-hidden />
        </span>
      </div>
      <div
        className={cn(
          "absolute inset-x-3 text-center leading-tight font-bold [text-shadow:0_2px_12px_rgb(0_0_0/0.8),0_0_2px_rgb(0_0_0)]",
          caption.position === "top" && "top-14",
          caption.position === "middle" && "top-[62%] -translate-y-1/2",
          caption.position === "bottom" && "bottom-12",
          caption.uppercase && "uppercase",
        )}
        style={{ fontFamily: FONT[caption.fontFamily], fontSize, color: caption.textColor }}
      >
        {words.map((w, i) => (
          <span key={i} style={i === highlight ? { color: caption.highlightColor } : undefined}>
            {w}{" "}
          </span>
        ))}
      </div>
      <p className="absolute inset-x-0 bottom-3 text-center text-[10px] text-white/45">Prévia ilustrativa · sem vídeo</p>
    </div>
  );
}
