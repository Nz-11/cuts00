/**
 * Verificação de vídeos pelo endpoint oEmbed oficial do YouTube.
 * Gratuito, sem chave de API, e retorna apenas metadados públicos
 * (título e canal) — nunca o conteúdo do vídeo.
 */

export type OEmbedResult =
  | { kind: "found"; title: string; channel: string }
  /** 401/403: vídeo privado ou com incorporação desativada. */
  | { kind: "restricted" }
  /** 400/404: vídeo inexistente ou removido. */
  | { kind: "not_found" }
  /** Sem conexão, timeout ou resposta inesperada. */
  | { kind: "unavailable"; reason: string };

export async function lookupYouTubeVideo(videoId: string, fetchImpl: typeof fetch = fetch): Promise<OEmbedResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;
  try {
    const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (res.status === 401 || res.status === 403) return { kind: "restricted" };
    if (res.status === 400 || res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "unavailable", reason: `HTTP ${res.status}` };
    const data = (await res.json()) as { title?: unknown; author_name?: unknown };
    if (typeof data.title !== "string") return { kind: "unavailable", reason: "resposta sem título" };
    return { kind: "found", title: data.title, channel: typeof data.author_name === "string" ? data.author_name : "" };
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.name : "erro de rede" };
  }
}
