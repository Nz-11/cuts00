import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ProjectNotFound, ProjectSkeleton } from "@/components/projects/project-not-found";
import { NoClipsToReview, ReviewEditor } from "@/components/review/review-view";
import { getProject } from "@/server/project-store";

export const metadata: Metadata = { title: "Revisão de cortes" };

export default function ReviewPage(props: PageProps<"/projects/[id]/review">) {
  return (
    <Suspense fallback={<ProjectSkeleton />}>
      <ReviewLoader params={props.params} />
    </Suspense>
  );
}

async function ReviewLoader({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return <ProjectNotFound />;
  if (project.clips.length === 0) return <NoClipsToReview projectHref={`/projects/${project.id}`} />;
  return <ReviewEditor key={project.id} project={project} />;
}
