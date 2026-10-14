import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { formatBytes } from "@/lib/format";
import { ACCEPTED_VIDEO_EXTENSIONS, MAX_UPLOAD_BYTES, probeMedia, ProbeUnavailableError, type ProbeResult } from "@/server/media";
import { getProject, projectMediaDir, resolveDataPath, StoreError, transitionProject } from "@/server/project-store";

/**
 * Recebe o arquivo de vídeo autorizado de um projeto (corpo binário, em streaming).
 *
 *   PUT /api/projects/:id/media
 *   X-File-Name: <nome original, URI-encoded>
 *
 * O arquivo é gravado em `.data/media/:id/`, validado com o ffprobe e o
 * projeto passa para "transcrição" (na fila, aguardando o worker local).
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/projects/[id]/media">) {
  const { id } = await ctx.params;
  const project = await getProject(id);
  if (!project) return json(404, "Projeto não encontrado.");
  if (project.status !== "awaiting_source") return json(409, "Este projeto já tem um arquivo. Remova o atual antes de enviar outro.");

  let originalName = "video";
  try {
    originalName = decodeURIComponent(request.headers.get("x-file-name") ?? "").trim() || originalName;
  } catch {
    return json(400, "Cabeçalho X-File-Name inválido.");
  }
  const ext = path.extname(originalName).toLowerCase();
  if (!(ACCEPTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return json(415, `Formato não suportado. Envie ${ACCEPTED_VIDEO_EXTENSIONS.join(", ")}.`);
  }
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_UPLOAD_BYTES) return json(413, `Arquivo maior que o limite de ${formatBytes(MAX_UPLOAD_BYTES)}.`);
  if (!request.body) return json(400, "Corpo da requisição vazio.");

  const relDir = projectMediaDir(id);
  const suffix = randomUUID().slice(0, 8);
  const relFinal = path.join(relDir, `source-${suffix}${ext}`);
  const partPath = resolveDataPath(path.join(relDir, `upload-${suffix}.part`));
  const finalPath = resolveDataPath(relFinal);
  await mkdir(path.dirname(partPath), { recursive: true });

  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      done(received > MAX_UPLOAD_BYTES ? new Error("limite excedido") : null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(request.body as unknown as NodeWebStream<Uint8Array>), limiter, createWriteStream(partPath));
  } catch {
    await rm(partPath, { force: true });
    return json(received > MAX_UPLOAD_BYTES ? 413 : 400, received > MAX_UPLOAD_BYTES ? "Arquivo maior que o limite permitido." : "O envio foi interrompido. Tente novamente.");
  }
  if (received === 0) {
    await rm(partPath, { force: true });
    return json(400, "O arquivo está vazio.");
  }

  let probe: ProbeResult | undefined;
  let probeNote = "";
  try {
    probe = await probeMedia(partPath);
  } catch (err) {
    if (err instanceof ProbeUnavailableError) {
      probeNote = " (metadados não verificados: ffprobe ausente)";
    } else {
      await rm(partPath, { force: true });
      return json(422, "Não foi possível ler este arquivo como vídeo. Ele pode estar corrompido ou em um formato não suportado.");
    }
  }
  if (probe && !probe.hasVideo) {
    await rm(partPath, { force: true });
    return json(422, "O arquivo não contém uma faixa de vídeo.");
  }
  if (probe && !probe.hasAudio) {
    await rm(partPath, { force: true });
    return json(422, "O arquivo não tem faixa de áudio, então não é possível transcrevê-lo.");
  }

  await rename(partPath, finalPath);
  try {
    const updated = await transitionProject(id, "transcribing", {
      note: `Arquivo recebido: ${originalName} (${formatBytes(received)})${probeNote}`,
      job: { state: "queued", progress: 0, message: "Aguardando o worker local de transcrição" },
      apply: (p) => {
        p.media = {
          originalName: originalName.slice(0, 255),
          sizeBytes: received,
          storedPath: relFinal.split(path.sep).join("/"),
          uploadedAt: new Date().toISOString(),
          durationSec: probe?.durationSec,
          width: probe?.width,
          height: probe?.height,
          videoCodec: probe?.videoCodec,
          hasAudio: probe?.hasAudio,
        };
      },
    });
    return Response.json({ ok: true, project: updated });
  } catch (err) {
    // Outro envio concorrente venceu, ou o projeto foi removido no meio do caminho.
    await rm(finalPath, { force: true });
    if (err instanceof StoreError) return json(err.code === "not_found" ? 404 : 409, err.message);
    throw err;
  }
}

function json(status: number, error: string) {
  return Response.json({ ok: false, error }, { status });
}
