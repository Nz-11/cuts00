"use client";

/**
 * Envia o arquivo de vídeo para o servidor local com progresso.
 * Usa XMLHttpRequest porque `fetch` não informa progresso de upload.
 */
export function uploadProjectMedia(projectId: string, file: File, onProgress: (fraction: number) => void): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/projects/${encodeURIComponent(projectId)}/media`);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let error = `Falha no envio (HTTP ${xhr.status}).`;
      try {
        error = (JSON.parse(xhr.responseText) as { error?: string }).error ?? error;
      } catch {
        // resposta sem JSON
      }
      resolve({ ok: false, error });
    };
    xhr.onerror = () => resolve({ ok: false, error: "Não foi possível conectar ao servidor local. Ele está rodando?" });
    xhr.onabort = () => resolve({ ok: false, error: "Envio cancelado." });
    xhr.send(file);
  });
}
