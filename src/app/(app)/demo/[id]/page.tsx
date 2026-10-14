import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectNotFound, ProjectSkeleton } from "@/components/projects/project-not-found";
import { ProjectStatusView } from "@/components/projects/project-status-view";
import { DEMO_PROJECTS, getDemoProject } from "@/lib/demo-data";

export const metadata: Metadata = { title: "Exemplo demonstrativo" };

export function generateStaticParams() {
  return DEMO_PROJECTS.map((p) => ({ id: p.id }));
}

export default function DemoProjectPage(props: PageProps<"/demo/[id]">) {
  return (
    <Suspense fallback={<ProjectSkeleton />}>
      <DemoLoader params={props.params} />
    </Suspense>
  );
}

async function DemoLoader({ params }: { params: Promise<{ id: string }> }) {
  const project = getDemoProject((await params).id);
  return project ? <ProjectStatusView project={project} demo /> : <ProjectNotFound />;
}
