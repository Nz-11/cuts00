import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { downloadFileName, RENDER_FILE_RE } from "@/lib/render";
import { parseRange } from "@/server/http-range";
import { getProject, projectMediaDir, resolveDataPath } from "@/server/project-store";

/**
 * Entrega o MP4 renderizado de um corte (somente leitura, com Range).
 *
 *   GET /api/projects/:id/renders/:clipId              → pré-visualização no navegador
 *   GET /api/projects/:id/renders/:clipId?download=1   → salvar o arquivo
 *
 * Só serve o arquivo registrado na renderização concluída do próprio corte,
 * dentro de `.data/media/:id/renders/`.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/projects/[id]/renders/[clipId]">) {
  const { id, clipId } = await ctx.params;
  const project = await getProject(id);
  const clip = project?.clips.find((c) => c.id === clipId);
  const file = clip?.render?.state === "done" ? clip.render.file : undefined;
  if (!project || !clip || !file || !RENDER_FILE_RE.test(file)) return json(404, "Este corte ainda não foi renderizado.");

  let filePath: string;
  try {
    filePath = resolveDataPath(path.join(projectMediaDir(id), file));
  } catch {
    return json(404, "Arquivo fora da pasta de dados.");
  }
  if (path.dirname(filePath) !== resolveDataPath(path.join(projectMediaDir(id), "renders"))) return json(404, "Arquivo fora da pasta do projeto.");

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return json(404, "O arquivo renderizado não está mais na pasta de dados.");
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const name = downloadFileName(project.title, clip);
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
  });
  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const stream = createReadStream(filePath, { start, end });
  request.signal.addEventListener("abort", () => stream.destroy());
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: range ? 206 : 200, headers });
}

function json(status: number, error: string) {
  return Response.json({ ok: false, error }, { status });
}
