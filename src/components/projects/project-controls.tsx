"use client";

import { FileVideo, Loader2, RefreshCw, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/states";
import { cn, formatBytes } from "@/lib/format";
import { uploadProjectMedia } from "@/lib/upload-client";
import { deleteProjectAction, removeMediaAction, retryTranscriptionAction } from "@/server/actions";

const ACCEPTED = ".mp4,.mov,.mkv,.webm,.m4v";

/** Envio do arquivo autorizado para um projeto em "aguardando arquivo". */
export function UploadPanel({ projectId, fromYouTube }: { projectId: string; fromYouTube: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!file) return;
    setError(null);
    setProgress(0);
    const result = await uploadProjectMedia(projectId, file, setProgress);
    if (!result.ok) {
      setProgress(null);
      return setError(result.error);
    }
    router.refresh();
  }

  const uploading = progress !== null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-[15px] font-semibold text-white">Envie o arquivo do vídeo</h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-300">
          {fromYouTube
            ? "Para gerar cortes, precisamos do arquivo original deste vídeo. Use o arquivo exportado do seu editor ou baixe o vídeo do seu próprio canal pelo YouTube Studio (Conteúdo → ⋮ → Baixar)."
            : "Selecione o arquivo de vídeo que você tem direito de usar."}
        </p>
      </div>

      <label
        htmlFor={inputId}
        className={cn(
          "group flex cursor-pointer items-center gap-4 rounded-2xl border border-dashed p-5 transition-all duration-300 hover:border-violet-glow/50 hover:bg-violet-glow/[0.04]",
          error ? "border-rose-400/50" : "border-white/15",
          uploading && "pointer-events-none opacity-60",
        )}
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-violet-glow/15 text-violet-soft">
          {file ? <FileVideo className="size-5" aria-hidden /> : <UploadCloud className="size-5 transition-transform group-hover:-translate-y-0.5" aria-hidden />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-white">{file ? file.name : "Escolher arquivo"}</span>
          <span className="text-xs text-ink-400">{file ? formatBytes(file.size) : "MP4, MOV, MKV, WebM ou M4V"}</span>
        </span>
      </label>
      <input id={inputId} type="file" accept={ACCEPTED} className="sr-only" disabled={uploading} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

      {uploading && (
        <div aria-live="polite">
          <div className="mb-1.5 flex justify-between text-xs text-ink-300">
            <span>{progress < 1 ? "Enviando para a pasta local…" : "Verificando o vídeo com ffprobe…"}</span>
            <span className="font-mono tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-glow to-cyan-glow transition-[width] duration-300" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
      {error && <Notice tone="warning">{error}</Notice>}

      <Button onClick={send} disabled={!file || uploading} icon={uploading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UploadCloud className="size-4" aria-hidden />}>
        {uploading ? "Enviando…" : "Enviar arquivo"}
      </Button>
    </div>
  );
}

export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Button variant="secondary" onClick={() => setConfirming(true)} icon={<Trash2 className="size-4" aria-hidden />}>
        Excluir
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const result = await deleteProjectAction(projectId);
          if (!result.ok) {
            setPending(false);
            return setError(result.error);
          }
          router.push("/");
        }}
      >
        {pending ? "Excluindo…" : "Excluir projeto e arquivo"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
        Cancelar
      </Button>
      {error && <p className="w-full text-xs text-rose-300">{error}</p>}
    </div>
  );
}

export function RemoveMediaButton({ projectId, label = "Trocar arquivo" }: { projectId: string; label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        icon={pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
        onClick={async () => {
          setPending(true);
          const result = await removeMediaAction(projectId);
          setPending(false);
          if (!result.ok) return setError(result.error);
          router.refresh();
        }}
      >
        {label}
      </Button>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

/** Recoloca na fila de transcrição, mantendo o mesmo arquivo. */
export function RetryTranscriptionButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        size="sm"
        disabled={pending}
        icon={pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
        onClick={async () => {
          setPending(true);
          const result = await retryTranscriptionAction(projectId);
          setPending(false);
          if (!result.ok) return setError(result.error);
          router.refresh();
        }}
      >
        Tentar transcrever de novo
      </Button>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

/** Recarrega os dados do servidor periodicamente enquanto há processamento. */
export function AutoRefresh({ intervalMs = 8000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
