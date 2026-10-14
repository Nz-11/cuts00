"use server";

import { rm, stat } from "node:fs/promises";
import { refresh } from "next/cache";
import type { Clip, ClipDecision } from "@/lib/types";
import { parseYouTubeVideoId } from "@/lib/youtube";
import { createProject, deleteProject, findProjectByVideoId, getProject, resolveDataPath, StoreError, transitionProject, updateProject } from "./project-store";
import { lookupYouTubeVideo } from "./youtube-oembed";

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; field?: "url" | "title" | "rights"; existingId?: string };

const MAX_TITLE = 120;

function cleanTitle(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, MAX_TITLE) : "";
}

function failure(err: unknown): { ok: false; error: string } {
  if (err instanceof StoreError) return { ok: false, error: err.message };
  console.error(err);
  return { ok: false, error: "Erro inesperado no servidor. Veja o terminal do `npm run dev` para detalhes." };
}

/** Cadastra um projeto a partir de um link do YouTube (apenas referência + metadados). */
export async function createYouTubeProjectAction(input: { url: string; title?: string; rightsConfirmed: boolean }): Promise<ActionResult<{ id: string }>> {
  if (input.rightsConfirmed !== true) return { ok: false, field: "rights", error: "Confirme que você tem direito de usar este conteúdo." };
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) return { ok: false, field: "url", error: "Link inválido. Use um endereço como youtube.com/watch?v=… ou youtu.be/…" };

  try {
    const existing = await findProjectByVideoId(videoId);
    if (existing) return { ok: false, field: "url", error: `Este vídeo já está no projeto “${existing.title}”.`, existingId: existing.id };

    const lookup = await lookupYouTubeVideo(videoId);
    if (lookup.kind === "not_found") return { ok: false, field: "url", error: "O YouTube informou que este vídeo não existe ou foi removido. Confira o link." };

    const found = lookup.kind === "found" ? lookup : undefined;
    const project = await createProject({
      title: cleanTitle(input.title) || found?.title.slice(0, MAX_TITLE) || `Vídeo ${videoId}`,
      youtube: {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        title: found?.title,
        channel: found?.channel,
        verified: Boolean(found),
      },
    });
    refresh();
    return { ok: true, id: project.id };
  } catch (err) {
    return failure(err);
  }
}

/** Cadastra um projeto que receberá um arquivo local (o upload vem em seguida). */
export async function createFileProjectAction(input: { title?: string; fileName: string; rightsConfirmed: boolean }): Promise<ActionResult<{ id: string }>> {
  if (input.rightsConfirmed !== true) return { ok: false, field: "rights", error: "Confirme que você tem direito de usar este conteúdo." };
  const fallback = typeof input.fileName === "string" ? input.fileName.replace(/\.[^.]+$/, "") : "";
  const title = cleanTitle(input.title) || cleanTitle(fallback) || "Projeto sem título";
  try {
    const project = await createProject({ title });
    refresh();
    return { ok: true, id: project.id };
  } catch (err) {
    return failure(err);
  }
}

export async function deleteProjectAction(id: string): Promise<ActionResult> {
  try {
    await deleteProject(id);
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Remove o arquivo enviado e volta para "aguardando arquivo".
 * Permitido enquanto a transcrição ainda está na fila, ou após uma falha.
 */
export async function removeMediaAction(id: string): Promise<ActionResult> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    const queued = project.status === "transcribing" && project.job?.state === "queued";
    if (!queued && project.status !== "failed") return { ok: false, error: "O arquivo só pode ser trocado enquanto a transcrição não começou ou após uma falha." };

    const storedPath = project.media?.storedPath;
    await transitionProject(id, "awaiting_source", {
      note: "Arquivo removido pelo usuário",
      apply: (p) => {
        p.media = undefined;
      },
    });
    if (storedPath) await rm(resolveDataPath(storedPath), { force: true });
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Recoloca na fila de transcrição um projeto que falhou nessa etapa,
 * reaproveitando o arquivo já enviado.
 */
export async function retryTranscriptionAction(id: string): Promise<ActionResult> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    if (project.status !== "failed" || project.error?.stage !== "transcribe") return { ok: false, error: "Só é possível tentar de novo após uma falha na transcrição." };
    if (!project.media) return { ok: false, error: "O projeto não tem arquivo. Envie o vídeo novamente." };
    try {
      await stat(resolveDataPath(project.media.storedPath));
    } catch {
      return { ok: false, error: "O arquivo enviado não está mais na pasta de dados. Use “Recomeçar com outro arquivo”." };
    }
    await transitionProject(id, "transcribing", { note: "Nova tentativa de transcrição", job: { message: "Aguardando o worker local de transcrição" } });
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/** Ajuste manual de um corte durante a revisão. */
export async function updateClipAction(projectId: string, clipId: string, patch: { startSec?: number; endSec?: number; decision?: ClipDecision }): Promise<ActionResult<{ clip: Clip }>> {
  try {
    let updated: Clip | undefined;
    await updateProject(projectId, (project) => {
      if (project.status !== "review" && project.status !== "completed") throw new StoreError("invalid_transition", "Os cortes só podem ser editados durante a revisão.");
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip) throw new StoreError("not_found", "Corte não encontrado.");

      const startSec = patch.startSec ?? clip.startSec;
      const endSec = patch.endSec ?? clip.endSec;
      const limit = project.media?.durationSec ?? Infinity;
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec > limit || endSec - startSec < 1) {
        throw new StoreError("invalid_transition", "Intervalo inválido: o corte precisa ter pelo menos 1 segundo e estar dentro do vídeo.");
      }
      if (patch.decision && !["pending", "approved", "rejected"].includes(patch.decision)) throw new StoreError("invalid_transition", "Decisão inválida.");

      clip.startSec = startSec;
      clip.endSec = endSec;
      if (patch.decision) clip.decision = patch.decision;
      updated = { ...clip };
    });
    return { ok: true, clip: updated! };
  } catch (err) {
    return failure(err);
  }
}

export interface LegacyProjectInput {
  title: string;
  url?: string;
  createdAt?: string;
}

/** Importa rascunhos criados na v0.1 (salvos só no navegador). */
export async function importLegacyProjectsAction(items: LegacyProjectInput[]): Promise<ActionResult<{ imported: number; skipped: number }>> {
  if (!Array.isArray(items) || items.length > 200) return { ok: false, error: "Lista de importação inválida." };
  let imported = 0;
  let skipped = 0;
  try {
    for (const item of items) {
      const title = cleanTitle(item?.title) || "Projeto importado";
      const createdAt = typeof item?.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : undefined;
      const videoId = typeof item?.url === "string" ? parseYouTubeVideoId(item.url) : null;
      if (videoId && (await findProjectByVideoId(videoId))) {
        skipped++;
        continue;
      }
      await createProject({
        title,
        createdAt,
        youtube: videoId ? { url: `https://www.youtube.com/watch?v=${videoId}`, videoId, verified: false } : undefined,
      });
      imported++;
    }
    refresh();
    return { ok: true, imported, skipped };
  } catch (err) {
    return failure(err);
  }
}
