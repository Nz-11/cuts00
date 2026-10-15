"use server";

import { stat } from "node:fs/promises";
import path from "node:path";
import { refresh } from "next/cache";
import type { Clip, ClipDecision } from "@/lib/types";
import { CAPTIONS_LABEL, clipRangeProblem, FRAMING_LABEL, validateRenderRequest, type RenderRequestInput } from "@/lib/render";
import { parseYouTubeVideoId } from "@/lib/youtube";
import { createProject, deleteProject, findProjectByVideoId, getProject, projectMediaDir, resolveDataPath, restoreProject, StoreError, transitionProject, updateProject } from "./project-store";
import { confirmsTitle, dropTrashEntry, getTrashEntry, isTrashEntryId, moveToTrash, purgeTrashEntry, restoreMediaFile } from "./trash";
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

/**
 * Move o projeto para a lixeira. Exige o nome do projeto digitado: um clique
 * acidental, um clique duplo ou uma chamada repetida não excluem nada.
 */
export async function deleteProjectAction(id: string, confirmation: string): Promise<ActionResult> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado (talvez já tenha sido excluído)." };
    if (!confirmsTitle(confirmation, project.title)) return { ok: false, error: "Digite o nome do projeto exatamente como aparece para confirmar a exclusão." };
    await deleteProject(id);
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/** Restaura um item da lixeira: projeto inteiro ou vídeo trocado. */
export async function restoreTrashAction(entryId: string): Promise<ActionResult<{ projectId: string }>> {
  try {
    if (!isTrashEntryId(entryId)) return { ok: false, error: "Item da lixeira inválido." };
    const entry = await getTrashEntry(entryId);
    if (!entry) return { ok: false, error: "Item da lixeira não encontrado." };
    if (entry.kind === "project") {
      const project = await restoreProject(entryId);
      refresh();
      return { ok: true, projectId: project.id };
    }
    // Vídeo trocado: só volta se o projeto ainda existe e está sem arquivo.
    const project = await getProject(entry.projectId);
    if (!project) return { ok: false, error: "O projeto deste vídeo não existe mais." };
    if (project.status !== "awaiting_source" || project.media) return { ok: false, error: "O projeto já tem outro arquivo. Use “Trocar arquivo” nele antes de restaurar este." };
    await restoreMediaFile(entry);
    await transitionProject(project.id, "transcribing", {
      note: "Arquivo restaurado da lixeira",
      job: { message: "Aguardando o worker local de transcrição" },
      apply: (p) => void (p.media = entry.media),
    });
    await dropTrashEntry(entryId);
    refresh();
    return { ok: true, projectId: project.id };
  } catch (err) {
    return failure(err);
  }
}

/** Apaga um item da lixeira para sempre. Exige o nome digitado. */
export async function purgeTrashAction(entryId: string, confirmation: string): Promise<ActionResult> {
  try {
    if (!isTrashEntryId(entryId)) return { ok: false, error: "Item da lixeira inválido." };
    const entry = await getTrashEntry(entryId);
    if (!entry) return { ok: false, error: "Item da lixeira não encontrado." };
    if (!confirmsTitle(confirmation, entry.title)) return { ok: false, error: "Digite o nome exatamente como aparece para excluir definitivamente." };
    await purgeTrashEntry(entryId);
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

    // O vídeo vai para a lixeira (pode ser restaurado); a transcrição fica na pasta do projeto.
    const media = project.media;
    const entry = media ? await moveToTrash({ kind: "media", projectId: id, title: `${project.title} — ${media.originalName}`, media }, resolveDataPath(media.storedPath)) : null;
    try {
      await transitionProject(id, "awaiting_source", {
        note: "Arquivo movido para a lixeira pelo usuário",
        apply: (p) => {
          p.media = undefined;
        },
      });
    } catch (err) {
      if (entry) await restoreMediaFile(entry).then(() => dropTrashEntry(entry.id)).catch(() => undefined);
      throw err;
    }
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

async function hasTranscript(id: string) {
  try {
    await stat(resolveDataPath(path.join(projectMediaDir(id), "transcript.json")));
    return true;
  } catch {
    return false;
  }
}

/**
 * Recoloca na fila de seleção um projeto que falhou nessa etapa.
 * A transcrição é reaproveitada; o worker inicia uma nova rodada de seleção.
 */
export async function retrySelectionAction(id: string): Promise<ActionResult> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    if (project.status !== "failed" || project.error?.stage !== "select") return { ok: false, error: "Só é possível tentar de novo após uma falha na seleção de cortes." };
    if (!(await hasTranscript(id))) return { ok: false, error: "A transcrição não foi encontrada. Envie o vídeo novamente." };
    await transitionProject(id, "selecting", { note: "Nova tentativa de seleção de cortes", job: { message: "Aguardando o worker local (Ollama)" } });
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Descarta as sugestões atuais (e as decisões tomadas nelas) e pede uma nova
 * rodada de seleção ao worker. A transcrição é mantida.
 */
export async function regenerateClipsAction(id: string): Promise<ActionResult> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    if (project.status !== "review") return { ok: false, error: "Novas sugestões só podem ser pedidas durante a revisão." };
    if (!(await hasTranscript(id))) return { ok: false, error: "A transcrição não foi encontrada. Envie o vídeo novamente." };
    await transitionProject(id, "selecting", {
      note: `Novas sugestões solicitadas (${project.clips.length} anteriores descartadas)`,
      job: { message: "Aguardando o worker local (Ollama)" },
      apply: (p) => {
        p.clips = [];
      },
    });
    refresh();
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Coloca os cortes aprovados na fila de renderização do worker local.
 * Cada corte recebe uma cópia dos timestamps atuais e das opções escolhidas.
 */
export async function requestRenderAction(id: string, input: RenderRequestInput): Promise<ActionResult<{ count: number }>> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    const request = validateRenderRequest(project, input);
    if (!request.ok) return request;
    const now = new Date().toISOString();
    await transitionProject(id, "rendering", {
      note: `Renderização pedida: ${request.clipIds.length} corte(s) · ${FRAMING_LABEL[request.framing].title} · legenda ${CAPTIONS_LABEL[request.captions].title.toLowerCase()}`,
      job: { message: "Aguardando o worker local (FFmpeg)" },
      apply: (p) => {
        for (const clip of p.clips) {
          if (!request.clipIds.includes(clip.id)) continue;
          // Revalida no estado gravado (o projeto pode ter mudado desde a leitura).
          if (clip.decision !== "approved" || clipRangeProblem(clip, p.media?.durationSec)) throw new StoreError("invalid_transition", "Os cortes mudaram; recarregue a página.");
          clip.render = { state: "queued", progress: 0, framing: request.framing, captions: request.captions, startSec: clip.startSec, endSec: clip.endSec, requestedAt: now, updatedAt: now };
        }
      },
    });
    refresh();
    return { ok: true, count: request.clipIds.length };
  } catch (err) {
    return failure(err);
  }
}

/** Recoloca na fila só os cortes cuja renderização falhou, com as mesmas opções. */
export async function retryRenderAction(id: string): Promise<ActionResult<{ count: number }>> {
  try {
    const project = await getProject(id);
    if (!project) return { ok: false, error: "Projeto não encontrado." };
    if (project.status !== "completed" && !(project.status === "failed" && project.error?.stage === "render")) return { ok: false, error: "Não há renderização para tentar de novo." };
    const failed = project.clips.filter((c) => c.decision === "approved" && c.render?.state === "failed");
    if (failed.length === 0) return { ok: false, error: "Nenhum corte com falha na renderização." };
    const now = new Date().toISOString();
    await transitionProject(id, "rendering", {
      note: `Nova tentativa de renderização: ${failed.length} corte(s)`,
      job: { message: "Aguardando o worker local (FFmpeg)" },
      apply: (p) => {
        for (const clip of p.clips) {
          if (clip.decision === "approved" && clip.render?.state === "failed") {
            clip.render = { ...clip.render, state: "queued", progress: 0, error: undefined, updatedAt: now };
          }
        }
      },
    });
    refresh();
    return { ok: true, count: failed.length };
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
