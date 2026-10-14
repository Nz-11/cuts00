import { PROCESSING_STATUSES } from "@/lib/project-status";
import { listProjects, resolveDataPath } from "@/server/project-store";
import { checkWorkerAuth } from "@/server/worker-auth";

/**
 * Lista os projetos com trabalho pendente para o worker local.
 *   GET /api/worker/jobs   (Authorization: Bearer $CCA_WORKER_TOKEN)
 */
export async function GET(request: Request) {
  const denied = checkWorkerAuth(request);
  if (denied) return denied;

  const projects = await listProjects();
  const jobs = projects
    .filter((p) => PROCESSING_STATUSES.includes(p.status) && p.job)
    .map((p) => ({
      projectId: p.id,
      status: p.status,
      job: p.job,
      media: p.media ? { ...p.media, absolutePath: resolveDataPath(p.media.storedPath) } : null,
      clips: p.status === "rendering" ? p.clips.filter((c) => c.decision === "approved") : undefined,
    }))
    .reverse(); // mais antigos primeiro

  return Response.json({ ok: true, jobs });
}
