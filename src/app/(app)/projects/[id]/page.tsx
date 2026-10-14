import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ProjectNotFound, ProjectSkeleton } from "@/components/projects/project-not-found";
import { ProjectStatusView } from "@/components/projects/project-status-view";
import { getProject } from "@/server/project-store";

export const metadata: Metadata = { title: "Projeto" };

export default function ProjectPage(props: PageProps<"/projects/[id]">) {
  return (
    <Suspense fallback={<ProjectSkeleton />}>
      <ProjectLoader params={props.params} />
    </Suspense>
  );
}

async function ProjectLoader({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const project = await getProject(id);
  return project ? <ProjectStatusView project={project} /> : <ProjectNotFound />;
}
