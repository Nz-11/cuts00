"use client";

import { AlertTriangle, CheckCircle2, Clock, Download, Film, Loader2, RotateCcw, Subtitles, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AutoRefresh } from "@/components/projects/project-controls";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/states";
import { cn, formatBytes, formatDuration, formatTimecode } from "@/lib/format";
import { CAPTIONS_LABEL, FRAMING_LABEL, isRenderStale, RENDER_CAPTIONS, RENDER_FRAMINGS, renderQuality } from "@/lib/render";
import type { Clip, ClipRenderState, Project, RenderCaptions, RenderFraming } from "@/lib/types";
import { requestRenderAction, retryRenderAction } from "@/server/actions";

const STATE_LABEL: Record<ClipRenderState, string> = { queued: "Na fila", running: "Renderizando", done: "Pronto", failed: "Falhou" };

/**
 * Renderização dos cortes aprovados: opções, fila com progresso, pré-visualização e download.
 * `clips` são os cortes como estão na tela (decisões podem estar sendo salvas: `saving`).
 */
export function RenderPanel({ project, clips, saving }: { project: Project; clips: Clip[]; saving: boolean }) {
  const router = useRouter();
  const [framing, setFraming] = useState<RenderFraming>("face");
  const [captions, setCaptions] = useState<RenderCaptions>("classic");
  const [pending, setPending] = useState<"render" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approved = clips.filter((c) => c.decision === "approved");
  // Estado de renderização vem do servidor (atualizado pelo worker).
  const serverClips = new Map(project.clips.map((c) => [c.id, c]));
  const withRender = project.clips.filter((c) => c.render && c.decision === "approved");
  const rendering = project.status === "rendering";
  const canRequest = project.status === "review" || project.status === "completed" || (project.status === "failed" && project.error?.stage === "render");
  const failedCount = withRender.filter((c) => c.render?.state === "failed").length;

  async function render() {
    setPending("render");
    setError(null);
    const result = await requestRenderAction(project.id, { framing, captions, clipIds: approved.map((c) => c.id) });
    setPending(null);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  async function retry() {
    setPending("retry");
    setError(null);
    const result = await retryRenderAction(project.id);
    setPending(null);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  return (
    <Card id="renderizar" className="scroll-mt-24 overflow-hidden">
      {rendering && <AutoRefresh intervalMs={3000} />}
      <CardHeader icon={<Film className="size-4" />} title="Renderização 9:16" description="MP4 vertical (até 1080×1920, H.264 + AAC) gerado pelo FFmpeg neste computador." />

      <div className="space-y-6 p-5 sm:p-6">
        {canRequest && (
          <>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-ink-300">Enquadramento</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {RENDER_FRAMINGS.map((f) => (
                  <Choice key={f} name="framing" checked={framing === f} onChange={() => setFraming(f)} title={FRAMING_LABEL[f].title} description={FRAMING_LABEL[f].description} preview={<FramingPreview framing={f} />} />
                ))}
              </div>
            </fieldset>
            <SourceQuality media={project.media} framing={framing} />
            <fieldset>
              <legend className="mb-2 flex items-center gap-1.5 text-xs font-medium text-ink-300">
                <Subtitles className="size-3.5" aria-hidden /> Legendas em português (da transcrição)
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {RENDER_CAPTIONS.map((c) => (
                  <Choice key={c} name="captions" checked={captions === c} onChange={() => setCaptions(c)} title={CAPTIONS_LABEL[c].title} description={CAPTIONS_LABEL[c].description} preview={<CaptionPreview style={c} />} />
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={render}
                disabled={pending !== null || saving || approved.length === 0}
                icon={pending === "render" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Film className="size-4" aria-hidden />}
              >
                {approved.length === 0 ? "Aprove cortes para renderizar" : `Renderizar ${approved.length} corte${approved.length > 1 ? "s" : ""} aprovado${approved.length > 1 ? "s" : ""}`}
              </Button>
              {saving && <span className="text-xs text-ink-400">Salvando a revisão…</span>}
              {failedCount > 0 && (
                <Button variant="secondary" onClick={retry} disabled={pending !== null} icon={pending === "retry" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}>
                  Tentar novamente ({failedCount} com falha)
                </Button>
              )}
            </div>
          </>
        )}

        {rendering && (
          <Notice title="Renderizando no worker local" icon={<Loader2 className="size-4 animate-spin" />}>
            {project.job?.message ?? "Aguardando o worker."} Se o worker estiver desligado, os cortes continuam na fila. Durante a renderização, os ajustes da revisão ficam bloqueados.
          </Notice>
        )}
        {project.status === "failed" && project.error?.stage === "render" && (
          <Notice tone="warning" title="A renderização falhou">
            {project.error.message}
          </Notice>
        )}
        {error && <p className="text-sm text-rose-300">{error}</p>}

        {withRender.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Cortes renderizados">
            {withRender.map((clip) => (
              <RenderItem key={clip.id} projectId={project.id} clip={serverClips.get(clip.id) ?? clip} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function RenderItem({ projectId, clip }: { projectId: string; clip: Clip }) {
  const render = clip.render!;
  const stale = isRenderStale(clip);
  const src = `/api/projects/${projectId}/renders/${clip.id}?v=${encodeURIComponent(render.updatedAt)}`;
  return (
    <li className="surface flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-2 text-sm font-medium text-white">{clip.title}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-400">
            {formatTimecode(render.startSec)}–{formatTimecode(render.endSec)} · {FRAMING_LABEL[render.framing].title} · {CAPTIONS_LABEL[render.captions].title}
          </p>
        </div>
        <StateBadge state={render.state} />
      </div>

      {(render.state === "queued" || render.state === "running") && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={`Progresso de ${clip.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(render.progress * 100)}>
          <div className="h-full rounded-full bg-gradient-to-r from-violet-glow to-cyan-glow transition-[width] duration-500" style={{ width: `${Math.max(2, render.progress * 100)}%` }} />
        </div>
      )}

      {render.state === "failed" && <p className="text-xs leading-relaxed text-rose-300">{render.error}</p>}

      {render.state === "done" && (
        <>
          <video src={src} controls preload="metadata" playsInline className="mx-auto aspect-[9/16] w-full max-w-[240px] rounded-xl border border-white/10 bg-black object-contain" aria-label={`Prévia de ${clip.title}`} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-400">
              {render.durationSec ? formatDuration(render.durationSec) : ""} {render.sizeBytes ? `· ${formatBytes(render.sizeBytes)}` : ""}
            </span>
            <a
              href={`/api/projects/${projectId}/renders/${clip.id}?download=1`}
              download
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.08] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/[0.14]"
            >
              <Download className="size-3.5" aria-hidden /> Baixar MP4
            </a>
          </div>
          {render.framingNote && <p className="text-[11px] leading-snug text-ink-400">{render.framingNote}</p>}
          {render.qualityNote && <p className="text-[11px] leading-snug text-ink-400">{render.qualityNote}</p>}
          {stale && (
            <p className="flex items-start gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> O corte foi ajustado depois desta renderização. Renderize de novo para aplicar.
            </p>
          )}
        </>
      )}
    </li>
  );
}

/** Aviso antes de renderizar quando a fonte tem pouca resolução para o enquadramento escolhido. */
function SourceQuality({ media, framing }: { media: Project["media"]; framing: RenderFraming }) {
  const plan = renderQuality(media?.width, media?.height, framing);
  if (!media?.width || !media.height || !plan || plan.upscale <= 2) return null;
  const blur = renderQuality(media.width, media.height, "blur");
  return (
    <Notice tone="warning" title={`Vídeo de origem em ${media.width}×${media.height}`}>
      Neste enquadramento a imagem será ampliada cerca de {plan.upscale.toLocaleString("pt-BR")}× (saída {plan.width}×{plan.height}). Ampliar não cria detalhes que não existem na fonte: o
      resultado tende a ficar menos nítido.
      {framing !== "blur" && blur && blur.upscale < plan.upscale && <> Com “Fundo desfocado”, a ampliação cai para cerca de {blur.upscale.toLocaleString("pt-BR")}×.</>} Se tiver o mesmo vídeo em
      resolução maior, crie um projeto com ele.
    </Notice>
  );
}

function StateBadge({ state }: { state: ClipRenderState }) {
  const Icon = state === "done" ? CheckCircle2 : state === "failed" ? XCircle : state === "running" ? Loader2 : Clock;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        state === "done" && "bg-emerald-400/10 text-emerald-300",
        state === "failed" && "bg-rose-500/10 text-rose-300",
        state === "running" && "bg-cyan-glow/10 text-cyan-soft",
        state === "queued" && "bg-white/[0.06] text-ink-300",
      )}
    >
      <Icon className={cn("size-3", state === "running" && "animate-spin")} aria-hidden /> {STATE_LABEL[state]}
    </span>
  );
}

function Choice({ name, checked, onChange, title, description, preview }: { name: string; checked: boolean; onChange: () => void; title: string; description: string; preview: ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors",
        checked ? "border-violet-glow/50 bg-violet-glow/[0.08]" : "border-white/[0.08] hover:border-white/15",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {preview}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-ink-400">{description}</span>
      </span>
    </label>
  );
}

/** Miniatura ilustrativa de cada enquadramento. */
function FramingPreview({ framing }: { framing: RenderFraming }) {
  return (
    <span className="relative grid h-14 w-8 shrink-0 place-items-center overflow-hidden rounded-md border border-white/15 bg-ink-800" aria-hidden>
      {framing === "face" ? (
        <>
          <span className="absolute inset-0 bg-gradient-to-br from-violet-glow/70 to-cyan-glow/60" />
          <span className="relative size-3 rounded-full border border-white/80" />
        </>
      ) : framing === "crop" ? (
        <span className="absolute inset-0 bg-gradient-to-br from-violet-glow/70 to-cyan-glow/60" />
      ) : (
        <>
          <span className="absolute inset-0 bg-gradient-to-br from-violet-glow/40 to-cyan-glow/30 blur-[3px]" />
          <span className="relative h-[18px] w-full bg-gradient-to-br from-violet-glow to-cyan-glow" />
        </>
      )}
    </span>
  );
}

function CaptionPreview({ style }: { style: RenderCaptions }) {
  return (
    <span className="relative flex h-14 w-8 shrink-0 items-end justify-center overflow-hidden rounded-md border border-white/15 bg-ink-800 pb-2" aria-hidden>
      {style === "classic" && <span className="text-[6px] leading-none font-bold text-white [text-shadow:0_0_2px_#000]">frase curta</span>}
      {style === "keywords" && (
        <span className="text-[6px] leading-none font-bold text-white [text-shadow:0_0_2px_#000]">
          perdi <span className="text-yellow-300">30 mil</span>
        </span>
      )}
      {style === "highlight" && (
        <span className="mb-2 text-[6px] leading-none font-black text-white">
          SUA <span className="text-yellow-300">VEZ</span>
        </span>
      )}
      {style === "none" && <span className="text-[6px] text-ink-500">—</span>}
    </span>
  );
}
