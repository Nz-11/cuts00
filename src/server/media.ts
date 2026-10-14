import { spawn } from "node:child_process";

/** Extensões aceitas para o arquivo de vídeo autorizado. */
export const ACCEPTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"] as const;

/** Limite de segurança do protótipo (o arquivo fica no disco local). */
export const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;

export interface ProbeResult {
  durationSec?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export class ProbeUnavailableError extends Error {
  constructor() {
    super("ffprobe não encontrado no PATH. Instale o FFmpeg para validar os vídeos.");
    this.name = "ProbeUnavailableError";
  }
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

/** Lê metadados com o ffprobe local (parte do FFmpeg, gratuito). */
export function probeMedia(filePath: string, ffprobeBin = process.env.FFPROBE_PATH || "ffprobe"): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "ENOENT" ? new ProbeUnavailableError() : err));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe não conseguiu ler o arquivo: ${stderr.trim().split("\n")[0] || `código ${code}`}`));
      try {
        const data = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } };
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const duration = Number(data.format?.duration);
        resolve({
          durationSec: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : undefined,
          width: video?.width,
          height: video?.height,
          videoCodec: video?.codec_name,
          hasVideo: Boolean(video),
          hasAudio: streams.some((s) => s.codec_type === "audio"),
        });
      } catch {
        reject(new Error("Resposta inesperada do ffprobe."));
      }
    });
  });
}

/** Verifica se o ffprobe está disponível no PATH. */
export function isFfprobeAvailable(ffprobeBin = process.env.FFPROBE_PATH || "ffprobe"): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffprobeBin, ["-version"], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
