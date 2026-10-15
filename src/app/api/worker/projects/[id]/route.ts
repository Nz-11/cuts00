import { stat } from "node:fs/promises";
import path from "node:path";
import { parseWorkerClips } from "@/lib/clip-analysis";
import { isProjectStatus } from "@/lib/project-status";
import { RENDER_FILE_RE } from "@/lib/render";
import type { Clip, ClipRender, StageId } from "@/lib/types";
import { getProject, projectMediaDir, resolveDataPath, StoreError, transitionProject, updateClipRender, updateJob } from "@/server/project-store";
import { checkWorkerAuth } from "@/server/worker-auth";

/**
 * Atualizações enviadas pelo worker local.
 *   POST /api/worker/projects/:id   (Authorization: Bearer $CCA_WORKER_TOKEN)
 *
 *   { "action": "progress", "progress": 0.4, "message": "Transcrevendo…" }
 *   { "action": "transition", "to": "selecting", "note": "Transcrição concluída" }
 *   { "action": "transition", "to": "review", "clips": [...] }   (cada corte pode trazer `analysis`; ver clip-analysis.ts)
 *   { "action": "transition", "to": "failed", "error": { "stage": "transcribe", "message": "…" } }
 *   { "action": "clip", "clipId": "c1", "state": "running", "progress": 0.3 }
 *   { "action": "clip", "clipId": "c1", "state": "done", "file": "renders/c1-1a2b3c4d.mp4", "sizeBytes": 123, "durationSec": 41.2, "framingNote": "…" }
 *   { "action": "clip", "clipId": "c1", "state": "failed", "error": "…" }
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

    if (body.action === "clip") {
      const patch = await parseClipRender(id, body);
      if (typeof patch === "string") return bad(patch);
      const project = await updateClipRender(id, body.clipId as string, patch);
      return Response.json({ ok: true, project });
    }

    if (body.action === "transition") {
      if (!isProjectStatus(body.to)) return bad("`to` não é um status válido.");
      if (body.to === "completed") {
        const current = await getProject(id);
        if (current && !current.clips.some((c) => c.render?.state === "done")) {
          return Response.json({ ok: false, error: "Nenhum corte foi renderizado com sucesso." }, { status: 409 });
        }
      }
      let clips: Clip[] | undefined;
      if (body.to === "review") {
        clips = parseWorkerClips(body.clips);
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

    return bad("`action` deve ser `progress`, `transition` ou `clip`.");
  } catch (err) {
    if (err instanceof StoreError) {
      return Response.json({ ok: false, error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    throw err;
  }
}

/** Valida o relatório de renderização de um corte. Retorna a mensagem de erro, ou o patch. */
async function parseClipRender(projectId: string, body: Record<string, unknown>): Promise<Partial<ClipRender> | string> {
  if (typeof body.clipId !== "string" || !body.clipId) return "`clipId` obrigatório.";
  const state = body.state;
  if (state === "running") {
    const progress = Number(body.progress ?? 0);
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) return "`progress` deve estar entre 0 e 1.";
    return { state, progress };
  }
  if (state === "failed") {
    if (typeof body.error !== "string" || !body.error.trim()) return "`error` obrigatório quando o corte falha.";
    return { state, error: body.error.slice(0, 500) };
  }
  if (state === "done") {
    const file = body.file;
    if (typeof file !== "string" || !RENDER_FILE_RE.test(file)) return "`file` deve ser renders/<nome>.mp4.";
    const sizeBytes = Number(body.sizeBytes);
    const durationSec = Number(body.durationSec);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) return "`sizeBytes` e `durationSec` devem ser positivos.";
    try {
      const full = resolveDataPath(path.join(projectMediaDir(projectId), file));
      const info = await stat(full);
      if (!info.isFile() || info.size !== sizeBytes) return "O arquivo informado não confere com o que está no disco.";
    } catch {
      return "O arquivo informado não existe na pasta do projeto.";
    }
    const note = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 200) : "");
    const framingNote = note(body.framingNote);
    const qualityNote = note(body.qualityNote);
    return { state, progress: 1, file, sizeBytes, durationSec, ...(framingNote ? { framingNote } : {}), ...(qualityNote ? { qualityNote } : {}) };
  }
  return "`state` deve ser running, done ou failed.";
}

function bad(error: string) {
  return Response.json({ ok: false, error }, { status: 400 });
}
