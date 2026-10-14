import { isProjectStatus } from "@/lib/project-status";
import type { Clip, StageId } from "@/lib/types";
import { StoreError, transitionProject, updateJob } from "@/server/project-store";
import { checkWorkerAuth } from "@/server/worker-auth";

/**
 * Atualizações enviadas pelo worker local.
 *   POST /api/worker/projects/:id   (Authorization: Bearer $CCA_WORKER_TOKEN)
 *
 *   { "action": "progress", "progress": 0.4, "message": "Transcrevendo…" }
 *   { "action": "transition", "to": "selecting", "note": "Transcrição concluída" }
 *   { "action": "transition", "to": "review", "clips": [...] }
 *   { "action": "transition", "to": "failed", "error": { "stage": "transcribe", "message": "…" } }
 *
 * Transições inválidas são recusadas pela máquina de estados (409).
 */
const STAGES: StageId[] = ["ingest", "transcribe", "select", "review", "render"];

export async function POST(request: Request, ctx: RouteContext<"/api/worker/projects/[id]">) {
  const denied = checkWorkerAuth(request);
  if (denied) return denied;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("JSON inválido.");
  }

  try {
    if (body.action === "progress") {
      const progress = Number(body.progress);
      if (!Number.isFinite(progress) || progress < 0 || progress > 1) return bad("`progress` deve estar entre 0 e 1.");
      const project = await updateJob(id, {
        state: "running",
        progress,
        message: typeof body.message === "string" ? body.message.slice(0, 200) : undefined,
      });
      return Response.json({ ok: true, project });
    }

    if (body.action === "transition") {
      if (!isProjectStatus(body.to)) return bad("`to` não é um status válido.");
      let clips: Clip[] | undefined;
      if (body.to === "review") {
        clips = parseClips(body.clips);
        if (!clips) return bad("`clips` inválido: envie uma lista com id, title, startSec, endSec, score, reason, hook, transcript e tags.");
      }
      let error: { stage: StageId; message: string } | undefined;
      if (body.to === "failed") {
        const e = body.error as { stage?: unknown; message?: unknown } | undefined;
        if (!e || !STAGES.includes(e.stage as StageId) || typeof e.message !== "string") return bad("`error` deve ter `stage` e `message`.");
        error = { stage: e.stage as StageId, message: e.message.slice(0, 500) };
      }
      const project = await transitionProject(id, body.to, {
        note: typeof body.note === "string" ? body.note.slice(0, 200) : undefined,
        error,
        apply: clips ? (p) => void (p.clips = clips) : undefined,
      });
      return Response.json({ ok: true, project });
    }

    return bad("`action` deve ser `progress` ou `transition`.");
  } catch (err) {
    if (err instanceof StoreError) {
      return Response.json({ ok: false, error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    throw err;
  }
}

function parseClips(value: unknown): Clip[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return undefined;
  const clips: Clip[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    const { id, title, startSec, endSec, score, reason, hook, transcript, tags } = raw ?? {};
    const valid =
      typeof id === "string" &&
      typeof title === "string" &&
      typeof startSec === "number" &&
      typeof endSec === "number" &&
      endSec > startSec &&
      startSec >= 0 &&
      typeof score === "number" &&
      typeof reason === "string" &&
      typeof hook === "string" &&
      typeof transcript === "string" &&
      Array.isArray(tags) &&
      tags.every((t) => typeof t === "string");
    if (!valid) return undefined;
    clips.push({ id, title, startSec, endSec, score: Math.max(0, Math.min(100, score)), reason, hook, transcript, tags: tags as string[], decision: "pending" });
  }
  return clips;
}

function bad(error: string) {
  return Response.json({ ok: false, error }, { status: 400 });
}
