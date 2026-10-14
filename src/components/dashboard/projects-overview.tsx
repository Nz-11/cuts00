import { ArrowRight, Clock3, FolderOpen, Plus, Scissors, Sparkles, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { ProjectList } from "@/components/projects/project-list";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { formatDuration } from "@/lib/format";
import type { Project } from "@/lib/types";
import { EngineStatus } from "./engine-status";
import { StatCard } from "./stat-card";

/** Estatísticas e lista calculadas SOMENTE a partir dos projetos reais. */
export function ProjectsOverview({ projects }: { projects: Project[] }) {
  const clips = projects.flatMap((p) => p.clips);
  const mediaSeconds = projects.reduce((sum, p) => sum + (p.media?.durationSec ?? 0), 0);
  const decided = clips.filter((c) => c.decision !== "pending");
  const approval = decided.length ? decided.filter((c) => c.decision === "approved").length / decided.length : null;

  return (
    <>
      <section aria-labelledby="stats-title">
        <h2 id="stats-title" className="mb-4 font-display text-sm font-semibold tracking-tight text-ink-100">
          Seus números
        </h2>
        <div className="stagger grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
          <StatCard label="Projetos" value={projects.length} hint="Salvos neste computador" icon={<FolderOpen className="size-4" />} />
          <StatCard label="Cortes sugeridos" value={clips.length} hint="Gerados pela IA" icon={<Scissors className="size-4" />} />
          <StatCard label="Vídeo enviado" value={mediaSeconds ? formatDuration(mediaSeconds) : "0 min"} hint="Duração total dos arquivos" icon={<Clock3 className="size-4" />} />
          <StatCard label="Taxa de aprovação" value={approval === null ? "—" : `${Math.round(approval * 100)}%`} hint="Cortes aprovados na revisão" icon={<ThumbsUp className="size-4" />} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader
            icon={<Sparkles className="size-4" />}
            title="Seus projetos"
            description="Projetos reais, salvos na pasta de dados local."
            action={
              projects.length > 0 ? (
                <Link href="/projects/new" className="hidden items-center gap-1 text-xs font-medium text-cyan-soft hover:text-white sm:inline-flex">
                  Criar <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : undefined
            }
          />
          {projects.length === 0 ? (
            <EmptyState
              icon={<FolderOpen className="size-6" />}
              title="Nenhum projeto ainda"
              description="Cadastre um vídeo do seu canal pelo link do YouTube ou envie um arquivo que você tem direito de usar."
              action={
                <ButtonLink href="/projects/new" icon={<Plus className="size-4" aria-hidden />}>
                  Criar primeiro projeto
                </ButtonLink>
              }
            />
          ) : (
            <ProjectList projects={projects.slice(0, 8)} basePath="/projects" />
          )}
        </Card>

        <EngineStatus />
      </div>
    </>
  );
}

export function ProjectsOverviewSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Carregando projetos">
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    </div>
  );
}
