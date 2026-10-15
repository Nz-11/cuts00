"use client";

import { Pause, Play, RectangleVertical, SkipBack } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, formatTimecode } from "@/lib/format";

/**
 * Player do vídeo original (servido localmente por /api/projects/:id/media)
 * que toca apenas o intervalo do corte selecionado.
 *
 * - Ao trocar de corte ou ajustar o início, posiciona no início.
 * - Ao ajustar o fim, posiciona 3 s antes dele, para ouvir o final.
 * - "Guia 9:16" mostra a área central que caberia num vídeo vertical
 *   (apenas referência: a renderização ainda não existe).
 */
export function ClipPlayer({ src, startSec, endSec }: { src: string; startSec: number; endSec: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(startSec);
  const [guide, setGuide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const last = useRef({ startSec, endSec });

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const prev = last.current;
    last.current = { startSec, endSec };
    const target = prev.endSec !== endSec && prev.startSec === startSec ? Math.max(startSec, endSec - 3) : startSec;
    el.pause();
    if (el.readyState >= 1) el.currentTime = target;
    setTime(target);
  }, [startSec, endSec]);

  function toggle() {
    const el = video.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (el.currentTime < startSec || el.currentTime >= endSec - 0.05) el.currentTime = startSec;
    void el.play().catch(() => setError("O navegador bloqueou a reprodução. Clique de novo em Tocar."));
  }

  function restart() {
    const el = video.current;
    if (!el) return;
    el.currentTime = startSec;
    setTime(startSec);
  }

  const length = Math.max(0.001, endSec - startSec);
  const progress = Math.min(1, Math.max(0, (time - startSec) / length));

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_30px_80px_-30px_rgb(139_92_246/0.5)]">
        <video
          ref={video}
          src={src}
          preload="metadata"
          playsInline
          className="block aspect-video w-full bg-black object-contain"
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = startSec;
            setError(null);
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setTime(t);
            if (t >= endSec) {
              e.currentTarget.pause();
              e.currentTarget.currentTime = endSec;
            }
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setError("Não foi possível carregar o vídeo neste navegador. Arquivos .mkv e .mov às vezes não tocam; os cortes continuam válidos.")}
          aria-label="Prévia do corte no vídeo original"
        />
        {guide && !error && (
          <div className="pointer-events-none absolute inset-0 flex justify-center" aria-hidden>
            <div className="h-full flex-1 bg-black/55" />
            <div className="relative aspect-[9/16] h-full border-x-2 border-dashed border-cyan-glow/70">
              <span className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-cyan-soft">9:16 central</span>
            </div>
            <div className="h-full flex-1 bg-black/55" />
          </div>
        )}
      </div>

      {error ? (
        <p className="text-xs text-amber-300">{error}</p>
      ) : (
        <div className="space-y-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label="Posição no corte" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full rounded-full bg-gradient-to-r from-violet-glow to-cyan-glow transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button type="button" onClick={toggle} className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.08] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/[0.14]">
                {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                {playing ? "Pausar" : "Tocar corte"}
              </button>
              <button type="button" onClick={restart} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-ink-300 transition-colors hover:text-white" aria-label="Voltar ao início do corte">
                <SkipBack className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => setGuide((g) => !g)}
                aria-pressed={guide}
                className={cn("inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors", guide ? "text-cyan-soft" : "text-ink-400 hover:text-white")}
              >
                <RectangleVertical className="size-3.5" aria-hidden /> Guia 9:16
              </button>
            </div>
            <span className="font-mono text-[11px] text-ink-400 tabular-nums">
              {formatTimecode(Math.min(Math.max(time, startSec), endSec))} · {formatTimecode(startSec)}–{formatTimecode(endSec)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
