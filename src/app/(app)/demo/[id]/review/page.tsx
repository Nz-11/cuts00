import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectNotFound, ProjectSkeleton } from "@/components/projects/project-not-found";
import { NoClipsToReview, ReviewEditor } from "@/components/review/review-view";
import { DEMO_PROJECTS, getDemoProject } from "@/lib/demo-data";

export const metadata: Metadata = { title: "Exemplo de revisão" };

export function generateStaticParams() {
  return DEMO_PROJECTS.map((p) => ({ id: p.id }));
}

export default function DemoReviewPage(props: PageProps<"/demo/[id]/review">) {
  return (
    <Suspense fallback={<ProjectSkeleton />}>
      <DemoReviewLoader params={props.params} />
    </Suspense>
  );
}

async function DemoReviewLoader({ params }: { params: Promise<{ id: string }> }) {
  const project = getDemoProject((await params).id);
  if (!project) return <ProjectNotFound />;
  if (project.clips.length === 0) return <NoClipsToReview projectHref={`/demo/${project.id}`} />;
  return <ReviewEditor key={project.id} project={project} demo />;
}
