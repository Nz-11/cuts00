import { ChevronRight, Scissors } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/badge";
import { formatDate, formatDuration } from "@/lib/format";
import type { Project } from "@/lib/types";
import { ProjectThumb } from "./project-thumb";

/** `basePath` separa projetos reais (/projects) dos exemplos (/demo). */
export function ProjectList({ projects, basePath }: { projects: Project[]; basePath: "/projects" | "/demo" }) {
  return (
    <ul className="divide-y divide-white/[0.05]">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`${basePath}/${project.id}`}
            className="group flex items-center gap-4 px-5 py-3.5 transition-colors duration-200 hover:bg-white/[0.025] focus-visible:bg-white/[0.04] focus-visible:outline-none sm:px-6"
          >
            <ProjectThumb project={project} className="w-24 sm:w-28" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white transition-colors group-hover:text-cyan-soft">{project.title}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-400">
                <StatusBadge status={project.status} job={project.job} />
                <span>{formatDate(project.createdAt)}</span>
                {project.media?.durationSec && <span className="hidden sm:inline">{formatDuration(project.media.durationSec)}</span>}
                {project.clips.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Scissors className="size-3" aria-hidden />
                    {project.clips.length} cortes
                  </span>
                )}
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-ink-500 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-ink-200" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
