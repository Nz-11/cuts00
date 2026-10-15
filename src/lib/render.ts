import type { Clip, Project, RenderCaptions, RenderFraming } from "./types";

/**
 * Regras da renderização (usadas no servidor e na interface).
 * O worker valida tudo de novo antes de chamar o FFmpeg.
 */

export const RENDER_FRAMINGS: readonly RenderFraming[] = ["face", "crop", "blur"];
export const RENDER_CAPTIONS: readonly RenderCaptions[] = ["classic", "keywords", "highlight", "none"];

export const FRAMING_LABEL: Record<RenderFraming, { title: string; description: string }> = {
  face: {
    title: "Rosto",
    description: "Para pessoas falando diante da câmera. Recorte fixo no rosto, sem zoom. Sem rosto estável, usa o centro; com rosto pequeno (câmera no canto), usa o fundo desfocado.",
  },
  crop: { title: "Centralizado", description: "Preenche a tela 9:16 cortando as laterais por igual. Bom quando o assunto já está no meio da imagem." },
  blur: { title: "Fundo desfocado", description: "Mostra a imagem inteira sobre ela mesma ampliada e desfocada. Indicado para tutoriais e gravações de tela." },
};

export const CAPTIONS_LABEL: Record<RenderCaptions, { title: string; description: string }> = {
  classic: { title: "Clássica", description: "Frases curtas em até 2 linhas, brancas com contorno, na parte de baixo." },
  keywords: { title: "Palavras-chave", description: "Como a clássica, com no máximo 1 palavra importante em amarelo (números e o assunto do corte)." },
  highlight: { title: "Destaque", description: "Maiúsculas, 3 palavras por vez, palavra falada em amarelo." },
  none: { title: "Sem legenda", description: "Apenas o vídeo e o áudio." },
};

/**
 * Tamanho da saída conforme a resolução da fonte — mesma regra de `output_plan` no worker.
 * Acima de 3× de ampliação, a saída cai para 720×1280: ampliar mais não cria detalhe.
 */
export const MAX_UPSCALE = 3;

export function renderQuality(width: number | undefined, height: number | undefined, framing: RenderFraming) {
  if (!width || !height || width <= 0 || height <= 0) return null;
  let upscale: number;
  if (framing === "blur") {
    upscale = Math.min(1080 / width, 1920 / height);
  } else {
    upscale = 1920 / Math.min(height, (width * 16) / 9);
  }
  const low = upscale > MAX_UPSCALE;
  return { width: low ? 720 : 1080, height: low ? 1280 : 1920, upscale: Math.round((low ? (upscale * 1280) / 1920 : upscale) * 100) / 100 };
}

/** Duração máxima de um corte renderizado, em segundos. */
export const MAX_RENDER_SEC = 600;

/** Caminho de um MP4 gerado, relativo à pasta de mídia do projeto. */
export const RENDER_FILE_RE = /^renders\/[A-Za-z0-9_-]{1,80}\.mp4$/;

export function isRenderFraming(value: unknown): value is RenderFraming {
  return typeof value === "string" && (RENDER_FRAMINGS as readonly string[]).includes(value);
}

export function isRenderCaptions(value: unknown): value is RenderCaptions {
  return typeof value === "string" && (RENDER_CAPTIONS as readonly string[]).includes(value);
}

/** Problema nos timestamps de um corte, ou null se estiverem válidos para renderizar. */
export function clipRangeProblem(clip: Pick<Clip, "startSec" | "endSec">, durationSec: number | undefined): string | null {
  const { startSec, endSec } = clip;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return "timestamps inválidos";
  if (startSec < 0) return "começa antes do início do vídeo";
  if (endSec - startSec < 1) return "dura menos de 1 segundo";
  if (endSec - startSec > MAX_RENDER_SEC) return `dura mais de ${MAX_RENDER_SEC / 60} minutos`;
  if (durationSec !== undefined && endSec > durationSec + 0.05) return "termina depois do fim do vídeo";
  return null;
}

export type RenderRequestInput = { framing: unknown; captions: unknown; clipIds?: unknown };
export type RenderRequestResult = { ok: true; framing: RenderFraming; captions: RenderCaptions; clipIds: string[] } | { ok: false; error: string };

/** Valida um pedido de renderização contra o estado atual do projeto. */
export function validateRenderRequest(project: Project, input: RenderRequestInput): RenderRequestResult {
  const canStart = project.status === "review" || project.status === "completed" || (project.status === "failed" && project.error?.stage === "render");
  if (!canStart) return { ok: false, error: "A renderização só pode ser pedida na revisão (ou após uma renderização)." };
  if (!project.media) return { ok: false, error: "O projeto não tem vídeo." };
  if (!isRenderFraming(input.framing)) return { ok: false, error: "Enquadramento inválido." };
  if (!isRenderCaptions(input.captions)) return { ok: false, error: "Estilo de legenda inválido." };

  const approved = project.clips.filter((c) => c.decision === "approved");
  let clipIds: string[];
  if (input.clipIds === undefined) {
    clipIds = approved.map((c) => c.id);
  } else {
    if (!Array.isArray(input.clipIds) || !input.clipIds.every((id) => typeof id === "string")) return { ok: false, error: "Lista de cortes inválida." };
    clipIds = [...new Set(input.clipIds as string[])];
    const notApproved = clipIds.filter((id) => !approved.some((c) => c.id === id));
    if (notApproved.length) return { ok: false, error: "Só cortes aprovados na revisão podem ser renderizados." };
  }
  if (clipIds.length === 0) return { ok: false, error: "Aprove pelo menos um corte antes de renderizar." };

  for (const id of clipIds) {
    const clip = approved.find((c) => c.id === id)!;
    const problem = clipRangeProblem(clip, project.media.durationSec);
    if (problem) return { ok: false, error: `O corte “${clip.title}” ${problem}. Ajuste-o na revisão.` };
  }
  return { ok: true, framing: input.framing, captions: input.captions, clipIds };
}

/** A renderização ficou desatualizada porque o corte foi ajustado depois dela? */
export function isRenderStale(clip: Clip) {
  return Boolean(clip.render && (Math.abs(clip.render.startSec - clip.startSec) > 0.01 || Math.abs(clip.render.endSec - clip.endSec) > 0.01));
}

/** Nome sugerido ao salvar o MP4: só letras, números e hífens. */
export function downloadFileName(projectTitle: string, clip: Pick<Clip, "id" | "title">) {
  const slug = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  return `${[slug(projectTitle), clip.id, slug(clip.title)].filter(Boolean).join("-") || "corte"}.mp4`;
}
