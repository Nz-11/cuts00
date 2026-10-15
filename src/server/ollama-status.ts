const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Verifica se o Ollama local responde (usado só para exibir o status nas
 * configurações). Endereços que não sejam deste computador são ignorados.
 */
export async function isOllamaRunning(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(process.env.CCA_OLLAMA_URL || "http://127.0.0.1:11434");
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) return false;
  try {
    const res = await fetchImpl(new URL("/api/version", url), { signal: AbortSignal.timeout(1500), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
