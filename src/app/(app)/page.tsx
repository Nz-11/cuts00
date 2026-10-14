import { Plus } from "lucide-react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { DemoSection, Greeting, LegacyImport } from "@/components/dashboard/client-sections";
import { ProjectsOverview, ProjectsOverviewSkeleton } from "@/components/dashboard/projects-overview";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/states";
import { listProjects } from "@/server/project-store";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="space-y-8 sm:space-y-10">
      <PageHeader
        eyebrow={
          <>
            <span className="size-1.5 rounded-full bg-cyan-glow animate-pulse-ring" aria-hidden />
            Estúdio de cortes
          </>
        }
        title={
          <>
            Olá, <Greeting />
          </>
        }
        description="Transforme vídeos longos em cortes verticais prontos para Shorts, Reels e TikTok."
        actions={
          <ButtonLink href="/projects/new" size="lg" icon={<Plus className="size-4" aria-hidden />}>
            Novo projeto
          </ButtonLink>
        }
      />
      <LegacyImport />
      <Suspense fallback={<ProjectsOverviewSkeleton />}>
        <RealProjects />
      </Suspense>
      <DemoSection />
    </div>
  );
}

async function RealProjects() {
  await connection();
  const projects = await listProjects();
  return <ProjectsOverview projects={projects} />;
}
