import { ArrowLeft, Clapperboard, ExternalLink, FileVideo, History, Info, Link2, Scissors } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DemoBadge, StatusBadge } from "@/components/ui/badge";
import { EmptyState, ErrorState, Notice, PageHeader } from "@/components/ui/states";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import { PIPELINE_STAGES } from "@/lib/pipeline";
import { PROCESSING_STATUSES, STATUS_LABEL } from "@/lib/project-status";
import type { Project } from "@/lib/types";
import { PipelineProgress } from "./pipeline-progress";
import { AutoRefresh, DeleteProjectButton, RemoveMediaButton, RetryTranscriptionButton, UploadPanel } from "./project-controls";
import { ProjectThumb } from "./project-thumb";

const timeFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/**
 * Página de status. `demo` = exemplo fictício: sem ações e com aviso explícito.
 */
export function ProjectStatusView({ project, demo = false }: { project: Project; demo?: boolean }) {
  const base = demo ? "/demo" : "/projects";
  const processing = PROCESSING_STATUSES.includes(project.status);
  const queued = processing && project.job?.state === "queued";
  const { youtube, media } = project;

  return (
    <div className="space-y-6 sm:space-y-8">
      {!demo && processing && <AutoRefresh />}
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-ink-300 transition-colors hover:text-white">
        <ArrowLeft className="size-4" aria-hidden /> Dashboard
      </Link>

      <PageHeader
        eyebrow={
          <>
            <StatusBadge status={project.status} job={project.job} />
            {demo && <DemoBadge />}
          </>
        }
        title={project.title}
        actions={
          <>
            {project.clips.length > 0 && (
              <ButtonLink href={`${base}/${project.id}/review`} icon={<Scissors className="size-4" aria-hidden />}>
                Revisar {project.clips.length} cortes
              </ButtonLink>
            )}
            {!demo && <DeleteProjectButton projectId={project.id} />}
          </>
        }
      />

      {demo && <Notice tone="warning">Exemplo demonstrativo com dados fictícios. Nada aqui foi processado e nenhuma ação está disponível.</Notice>}

      <Card className="p-5 sm:p-7">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-[15px] font-semibold text-white">Processamento</h2>
          {project.job?.message && <span className="text-xs text-ink-400">{project.job.message}</span>}
        </div>
        <PipelineProgress project={project} />
      </Card>

      {!demo && project.status === "awaiting_source" && (
        <Card className="p-5 sm:p-7">
          <UploadPanel projectId={project.id} fromYouTube={Boolean(youtube)} />
        </Card>
      )}

      {!demo && queued && project.status === "transcribing" && (
        <Notice title="Na fila de transcrição — aguardando o worker local" icon={<Info className="size-4" />}>
          <p>
            O arquivo foi recebido e validado. A transcrição começa quando o worker local estiver rodando (<code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">workerstart.cmd</code>). Se ele estiver desligado, o projeto continua na fila. Esta página se atualiza sozinha.
          </p>
          <div className="mt-3">
            <RemoveMediaButton projectId={project.id} />
          </div>
        </Notice>
      )}

      {!demo && queued && project.status === "selecting" && (
        <Notice title="Transcrição pronta — seleção de cortes ainda não disponível" icon={<Info className="size-4" />}>
          A transcrição com timestamps foi salva na pasta de dados do projeto. A seleção de cortes por IA é a próxima etapa do desenvolvimento; até lá, o projeto aguarda nesta fase.
        </Notice>
      )}

      {project.status === "failed" && (
        <Card>
          <ErrorState
            title={`Falha na etapa: ${PIPELINE_STAGES.find((s) => s.id === project.error?.stage)?.label ?? "desconhecida"}`}
            description={project.error?.message ?? "Erro desconhecido."}
            action={
              !demo ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {project.error?.stage === "transcribe" && media && <RetryTranscriptionButton projectId={project.id} />}
                  <RemoveMediaButton projectId={project.id} label="Recomeçar com outro arquivo" />
                </div>
              ) : undefined
            }
          />
        </Card>
      )}

      {!demo && youtube && !youtube.verified && (
        <Notice tone="warning" title="Vídeo não confirmado no YouTube">
          Não foi possível confirmar o vídeo pelo oEmbed oficial (ele pode ser privado, ter incorporação desativada, ou não havia conexão). O projeto funciona normalmente; apenas o título não foi preenchido automaticamente.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader icon={<Scissors className="size-4" />} title="Cortes sugeridos" description={project.clips.length ? "Ordenados por pontuação da IA" : undefined} />
            {project.clips.length === 0 ? (
              <EmptyState
                icon={<Clapperboard className="size-6" />}
                title={processing ? "Cortes a caminho" : "Nenhum corte ainda"}
                description={
                  project.status === "awaiting_source"
                    ? "Envie o arquivo do vídeo para iniciar o processamento."
                    : processing
                      ? "As sugestões aparecem aqui depois da transcrição e da seleção por IA."
                      : "Nenhum corte foi gerado para este projeto."
                }
              />
            ) : (
              <ul className="divide-y divide-white/[0.05]">
                {[...project.clips]
                  .sort((a, b) => b.score - a.score)
                  .map((clip) => (
                    <li key={clip.id} className="flex items-center gap-4 px-5 py-3.5 sm:px-6">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-glow/25 to-cyan-glow/15 font-display text-sm font-semibold text-white tabular-nums">
                        {clip.score}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">{clip.title}</p>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {formatDuration(clip.endSec - clip.startSec)} · {clip.tags.join(" · ")}
                        </p>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader icon={<History className="size-4" />} title="Histórico" />
            <ol className="space-y-3 px-5 py-4 sm:px-6">
              {[...project.history].reverse().map((event, i) => (
                <li key={`${event.at}-${i}`} className="flex gap-3 text-sm">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet-soft" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-ink-100">
                      {STATUS_LABEL[event.status]}
                      {event.note && <span className="text-ink-400"> — {event.note}</span>}
                    </p>
                  </div>
                  <time dateTime={event.at} className="shrink-0 font-mono text-[11px] text-ink-500">
                    {timeFormat.format(new Date(event.at))}
                  </time>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <Card className="h-fit overflow-hidden">
          <ProjectThumb project={project} className="w-full rounded-none ring-0" />
          <dl className="space-y-3 p-5 text-sm">
            {youtube && (
              <>
                <Detail label="YouTube" value={<span className="inline-flex items-center gap-1.5"><Link2 className="size-3.5 text-cyan-soft" aria-hidden /><span className="font-mono text-xs">{youtube.videoId}</span></span>} />
                {youtube.channel && <Detail label="Canal" value={<span className="block max-w-44 truncate">{youtube.channel}</span>} />}
              </>
            )}
            {media ? (
              <>
                <Detail label="Arquivo" value={<span className="inline-flex max-w-44 items-center gap-1.5"><FileVideo className="size-3.5 shrink-0 text-cyan-soft" aria-hidden /><span className="truncate">{media.originalName}</span></span>} />
                <Detail label="Tamanho" value={formatBytes(media.sizeBytes)} />
                <Detail label="Duração" value={media.durationSec ? formatDuration(media.durationSec) : "—"} />
                {media.width && media.height && <Detail label="Resolução" value={`${media.width}×${media.height}${media.videoCodec ? ` · ${media.videoCodec}` : ""}`} />}
              </>
            ) : (
              <Detail label="Arquivo" value={<span className="text-ink-400">Não enviado</span>} />
            )}
            <Detail label="Criado em" value={formatDate(project.createdAt)} />
          </dl>
          {youtube && (
            <div className="border-t border-white/[0.05] px-5 py-3">
              <a href={youtube.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-soft hover:text-white">
                Abrir no YouTube <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-400">{label}</dt>
      <dd className="text-right text-ink-100">{value}</dd>
    </div>
  );
}
