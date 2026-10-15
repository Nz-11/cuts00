"use client";

import { ArrowLeft, Check, Clapperboard, Download, Film, Lightbulb, Quote, RotateCcw, Star, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, DemoBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, Notice, PageHeader } from "@/components/ui/states";
import { CRITERIA_LABEL, recommendedIds, strengths } from "@/lib/clip-analysis";
import { cn, formatDuration, formatTimecode } from "@/lib/format";
import { useSettings } from "@/lib/store";
import type { Clip, ClipDecision, Project } from "@/lib/types";
import { RegenerateClipsButton } from "@/components/projects/project-controls";
import { updateClipAction } from "@/server/actions";
import { AnalysisNotes, CriteriaBreakdown } from "./clip-analysis-panel";
import { ClipPlayer } from "./clip-player";
import { RenderPanel } from "./render-panel";
import { SourceTimeline } from "./source-timeline";
import { TrimControl } from "./trim-control";
import { VerticalPreview } from "./vertical-preview";

export function NoClipsToReview({ projectHref }: { projectHref: string }) {
  return (
    <Card>
      <EmptyState
        icon={<Clapperboard className="size-6" />}
        title="Nenhum corte para revisar"
        description="Este projeto ainda não tem cortes sugeridos. Eles aparecem aqui depois da transcrição e da seleção por IA."
        action={<ButtonLink href={projectHref}>Ver status do projeto</ButtonLink>}
      />
    </Card>
  );
}

const DECISION_LABEL: Record<ClipDecision, string> = { pending: "Pendente", approved: "Aprovado", rejected: "Rejeitado" };

/** `demo`: alterações ficam só na tela. Real: cada ajuste é salvo no servidor local. */
export function ReviewEditor({ project, demo = false }: { project: Project; demo?: boolean }) {
  const settings = useSettings();
  const [clips, setClips] = useState<Clip[]>(() => [...project.clips].sort((a, b) => b.score - a.score));
  const [selectedId, setSelectedId] = useState(clips[0].id);
  const [saveState, setSaveState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string }>({ kind: "idle" });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const selected = clips.find((c) => c.id === selectedId) ?? clips[0];
  const original = project.clips.find((c) => c.id === selected.id);
  const sourceDuration = project.media?.durationSec ?? Math.max(...clips.map((c) => c.endSec)) + 60;
  const base = demo ? "/demo" : "/projects";
  const hasVideo = !demo && Boolean(project.media);

  function update(clipId: string, patch: Partial<Pick<Clip, "startSec" | "endSec" | "decision">>) {
    const next = clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
    setClips(next);
    if (demo) return;

    // Agrupa cliques rápidos (ex.: vários ±0,5 s) em uma única gravação.
    const clip = next.find((c) => c.id === clipId)!;
    clearTimeout(timers.current.get(clipId));
    setSaveState({ kind: "saving" });
    timers.current.set(
      clipId,
      setTimeout(async () => {
        const result = await updateClipAction(project.id, clipId, { startSec: clip.startSec, endSec: clip.endSec, decision: clip.decision });
        setSaveState(result.ok ? { kind: "saved" } : { kind: "error", message: result.error });
      }, 400),
    );
  }

  const length = selected.endSec - selected.startSec;
  const lengthWarning =
    length < settings.clipMinSec ? `Mais curto que o mínimo configurado (${settings.clipMinSec}s).` : length > settings.clipMaxSec ? `Mais longo que o máximo configurado (${settings.clipMaxSec}s).` : null;
  const approved = clips.filter((c) => c.decision === "approved").length;
  const recommended = recommendedIds(clips);
  const selectedStrengths = selected.analysis ? strengths(selected.analysis) : [];
  const edited = original && (original.startSec !== selected.startSec || original.endSec !== selected.endSec);

  return (
    <div className="space-y-6 sm:space-y-8">
      <Link href={`${base}/${project.id}`} className="inline-flex items-center gap-1.5 text-sm text-ink-300 transition-colors hover:text-white">
        <ArrowLeft className="size-4" aria-hidden /> Status do projeto
      </Link>

      <PageHeader
        eyebrow={
          <>
            Revisão de cortes
            {demo && <DemoBadge />}
          </>
        }
        title={project.title}
        description={`${clips.length} cortes sugeridos · ${recommended.size} recomendados · ${approved} aprovados`}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {!demo && project.status === "review" && <RegenerateClipsButton projectId={project.id} />}
            {demo ? (
              <Button disabled title="Exemplo demonstrativo: não há vídeo para renderizar" icon={<Download className="size-4" aria-hidden />}>
                Exportar MP4
              </Button>
            ) : (
              <ButtonLink href="#renderizar" icon={<Film className="size-4" aria-hidden />}>
                Renderizar aprovados
              </ButtonLink>
            )}
          </div>
        }
      />

      {demo ? (
        <Notice tone="warning">Exemplo demonstrativo: as sugestões são fictícias e os ajustes feitos aqui não são salvos.</Notice>
      ) : project.status === "rendering" ? (
        <Notice title="Renderização em andamento">Os ajustes ficam bloqueados até o worker terminar. Acompanhe o progresso em “Renderização 9:16”, abaixo.</Notice>
      ) : (
        <SaveIndicator state={saveState} />
      )}

      <Card className="p-4 sm:p-5">
        <p className="mb-3 text-xs font-medium text-ink-300">Posição dos cortes no vídeo-fonte ({formatDuration(sourceDuration)})</p>
        <SourceTimeline clips={clips} durationSec={sourceDuration} selectedId={selected.id} onSelect={setSelectedId} />
      </Card>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Lista de cortes */}
        <div className="lg:col-span-4">
          <ul className="flex gap-3 overflow-x-auto pb-2 snap-x lg:flex-col lg:overflow-visible lg:pb-0" aria-label="Cortes sugeridos">
            {clips.map((clip, i) => {
              const active = clip.id === selected.id;
              return (
                <li key={clip.id} className="w-64 shrink-0 snap-start lg:w-auto">
                  <button
                    type="button"
                    onClick={() => setSelectedId(clip.id)}
                    aria-pressed={active}
                    className={cn(
                      "surface w-full rounded-2xl p-4 text-left transition-all duration-300",
                      active ? "border-violet-glow/50! shadow-[0_0_0_1px_rgb(139_92_246/0.35),0_20px_40px_-20px_rgb(139_92_246/0.6)]!" : "hover:border-white/15!",
                      clip.decision === "rejected" && !active && "opacity-55",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-ink-400">
                        #{i + 1} · {formatTimecode(clip.startSec)}
                      </span>
                      <ScorePill score={clip.score} />
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm font-medium text-white">{clip.title}</p>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400">
                      <span className="flex items-center gap-2">
                        <span className="font-mono tabular-nums">{formatDuration(clip.endSec - clip.startSec)}</span>
                        {recommended.has(clip.id) && <RecommendedBadge />}
                      </span>
                      <DecisionBadge decision={clip.decision} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Editor do corte selecionado */}
        <Card className="p-5 sm:p-6 lg:col-span-8">
          {hasVideo && (
            <div className="mb-6">
              <ClipPlayer src={`/api/projects/${project.id}/media`} startSec={selected.startSec} endSec={selected.endSec} />
            </div>
          )}
          <div key={selected.id} className={cn("grid animate-fade-up gap-6", !hasVideo && "md:grid-cols-[220px_1fr]")}>
            {!hasVideo && <VerticalPreview caption={settings.caption} text={selected.hook} className="mx-auto w-full max-w-[220px]" />}

            <div className="min-w-0 space-y-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <ScorePill score={selected.score} />
                  {recommended.has(selected.id) && <RecommendedBadge />}
                  {selected.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
                <h2 className="mt-3 font-display text-xl font-semibold tracking-tight text-white">{selected.title}</h2>
                {selected.hook && (
                  <p className="mt-1.5 text-sm text-ink-300">
                    <span className="text-ink-400">Gancho:</span> “{selected.hook}”
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-violet-glow/20 bg-violet-glow/[0.06] p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-violet-soft uppercase">
                  <Lightbulb className="size-3.5" aria-hidden /> Por que este trecho
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-100">{selected.reason}</p>
                {selectedStrengths.length > 0 && (
                  <p className="mt-2 text-xs text-ink-300">
                    <span className="text-ink-400">Mais pesaram a favor:</span> {selectedStrengths.map((k) => `${CRITERIA_LABEL[k].title} (${selected.analysis!.criteria[k]}/5)`).join(", ")}
                  </p>
                )}
              </div>

              {selected.analysis ? (
                <>
                  <CriteriaBreakdown analysis={selected.analysis} score={selected.score} />
                  <AnalysisNotes analysis={selected.analysis} />
                </>
              ) : (
                !demo && <p className="text-xs text-ink-400">Este corte foi sugerido antes da avaliação por critério. Use “Gerar novas sugestões” para ver as notas detalhadas.</p>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-white">
                    Duração: <span className="font-mono tabular-nums">{formatDuration(length)}</span>
                  </p>
                  {edited && original && (
                    <button type="button" className="inline-flex items-center gap-1 text-xs text-cyan-soft hover:text-white" onClick={() => update(selected.id, { startSec: original.startSec, endSec: original.endSec })}>
                      <RotateCcw className="size-3" aria-hidden /> Restaurar sugestão
                    </button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TrimControl id={`start-${selected.id}`} label="Início" value={selected.startSec} min={0} max={selected.endSec - 1} onChange={(v) => update(selected.id, { startSec: v })} />
                  <TrimControl id={`end-${selected.id}`} label="Fim" value={selected.endSec} min={selected.startSec + 1} max={sourceDuration} onChange={(v) => update(selected.id, { endSec: v })} />
                </div>
                {lengthWarning && <p className="mt-2 text-xs text-amber-300">{lengthWarning}</p>}
              </div>

              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-300">
                  <Quote className="size-3.5" aria-hidden /> Transcrição do trecho
                </p>
                <p className="text-sm leading-relaxed text-ink-200">{selected.transcript}</p>
              </div>

              <div className="flex flex-wrap gap-2 border-t border-white/[0.05] pt-5">
                <Button
                  variant={selected.decision === "approved" ? "primary" : "secondary"}
                  onClick={() => update(selected.id, { decision: selected.decision === "approved" ? "pending" : "approved" })}
                  icon={selected.decision === "approved" ? <Check className="size-4" aria-hidden /> : <ThumbsUp className="size-4" aria-hidden />}
                  aria-pressed={selected.decision === "approved"}
                >
                  {selected.decision === "approved" ? "Aprovado" : "Aprovar"}
                </Button>
                <Button
                  variant={selected.decision === "rejected" ? "danger" : "ghost"}
                  onClick={() => update(selected.id, { decision: selected.decision === "rejected" ? "pending" : "rejected" })}
                  icon={<ThumbsDown className="size-4" aria-hidden />}
                  aria-pressed={selected.decision === "rejected"}
                >
                  {selected.decision === "rejected" ? "Rejeitado" : "Rejeitar"}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {!demo && <RenderPanel project={project} clips={clips} saving={saveState.kind === "saving"} />}
    </div>
  );
}

function ScorePill({ score }: { score: number }) {
  const tone = score >= 85 ? "from-emerald-400/25 text-emerald-200" : score >= 75 ? "from-cyan-glow/25 text-cyan-100" : "from-violet-glow/25 text-violet-100";
  return <span className={cn("rounded-full bg-gradient-to-r to-transparent px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums", tone)}>{score} pts</span>;
}

function RecommendedBadge() {
  return (
    <Badge tone="amber">
      <Star className="size-3" aria-hidden /> Recomendado
    </Badge>
  );
}

function DecisionBadge({ decision }: { decision: ClipDecision }) {
  return <Badge tone={decision === "approved" ? "green" : decision === "rejected" ? "rose" : "neutral"}>{DECISION_LABEL[decision]}</Badge>;
}

function SaveIndicator({ state }: { state: { kind: "idle" | "saving" | "saved" } | { kind: "error"; message: string } }) {
  if (state.kind === "error") return <Notice tone="warning">Não foi possível salvar o último ajuste: {state.message}</Notice>;
  return (
    <p className="text-xs text-ink-400" aria-live="polite">
      {state.kind === "saving" ? "Salvando…" : state.kind === "saved" ? "Ajustes salvos na pasta de dados local." : "Os ajustes são salvos automaticamente."}
    </p>
  );
}
