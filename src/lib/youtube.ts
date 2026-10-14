/**
 * Utilitários para links do YouTube.
 *
 * Apenas interpretamos o link e exibimos a miniatura pública. O conteúdo do
 * vídeo nunca é baixado do YouTube: para processar, o usuário envia o arquivo
 * original que tem direito de usar. Metadados (título, duração) poderão vir da
 * YouTube Data API oficial, chamada pelo servidor com chave em variável de ambiente.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeVideoId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");
  let candidate: string | null = null;

  if (host === "youtu.be") {
    candidate = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      candidate = match?.[1] ?? null;
    }
  }

  return candidate && ID_PATTERN.test(candidate) ? candidate : null;
}

export function youTubeThumbnail(videoId: string) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
