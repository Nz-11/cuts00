/* eslint-disable @next/next/no-img-element -- miniatura externa pública, sem otimização necessária */
import { FileVideo, Link2 } from "lucide-react";
import { cn } from "@/lib/format";
import type { Project } from "@/lib/types";
import { youTubeThumbnail } from "@/lib/youtube";

/** Gera um gradiente estável a partir do id (projetos sem miniatura real). */
function hueFromId(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function ProjectThumb({ project, className }: { project: Project; className?: string }) {
  const hue = hueFromId(project.id);

  return (
    <div className={cn("relative aspect-video shrink-0 overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/[0.08]", className)}>
      {project.youtube ? (
        <img src={youTubeThumbnail(project.youtube.videoId)} alt="" className="size-full object-cover" loading="lazy" />
      ) : (
        <div
          className="size-full"
          style={{
            background: `radial-gradient(120% 90% at 20% 10%, hsl(${hue} 70% 45% / .55), transparent 60%), radial-gradient(100% 80% at 90% 100%, hsl(${(hue + 120) % 360} 80% 50% / .35), transparent 60%), #14141c`,
          }}
        />
      )}
      <span className="absolute bottom-1.5 left-1.5 grid size-5 place-items-center rounded-md bg-black/60 text-white/80 backdrop-blur">
        {project.youtube ? <Link2 className="size-3" aria-hidden /> : <FileVideo className="size-3" aria-hidden />}
      </span>
    </div>
  );
}
