/**
 * Interpreta o cabeçalho HTTP `Range` (apenas um intervalo de bytes), usado
 * pelo player de vídeo para buscar partes do arquivo.
 *
 *   "bytes=0-"      → do início ao fim
 *   "bytes=100-199" → 100 bytes
 *   "bytes=-500"    → os últimos 500 bytes
 *
 * Retorna `null` sem cabeçalho (arquivo inteiro) e `"invalid"` quando o
 * intervalo não pode ser atendido (resposta 416).
 */
export type ByteRange = { start: number; end: number };

export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "") || size <= 0) return "invalid";

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

export function videoContentType(fileName: string) {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return VIDEO_TYPES[ext] ?? "application/octet-stream";
}
