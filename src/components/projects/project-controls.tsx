"use client";

import { FileVideo, Loader2, RefreshCw, RotateCcw, Sparkles, Trash2, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/states";
import { cn, formatBytes } from "@/lib/format";
import type { Project } from "@/lib/types";
import { uploadProjectMedia } from "@/lib/upload-client";
import { deleteProjectAction, regenerateClipsAction, removeMediaAction, retrySelectionAction, retryTranscriptionAction } from "@/server/actions";

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

/**
 * Excluir abre uma confirmação separada: é preciso digitar o nome do projeto.
 * O projeto não é apagado: vai para a Lixeira, de onde pode ser restaurado.
 */
export function DeleteProjectButton({ project }: { project: Pick<Project, "id" | "title" | "media" | "clips"> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const renders = project.clips.filter((c) => c.render?.state === "done").length;

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} icon={<Trash2 className="size-4" aria-hidden />}>
        Excluir
      </Button>
      {open && (
        <ConfirmDialog
          title="Mover projeto para a lixeira?"
          confirmLabel="Mover para a lixeira"
          requireText={project.title}
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            const result = await deleteProjectAction(project.id, project.title);
            if (!result.ok) return result.error;
            router.push("/");
            return null;
          }}
        >
          <p>
            O projeto <span className="font-semibold text-white">{project.title}</span> sai da lista
            {project.media ? `, junto com o vídeo (${formatBytes(project.media.sizeBytes)}), a transcrição` : ""}
            {renders ? ` e ${renders} corte${renders > 1 ? "s" : ""} renderizado${renders > 1 ? "s" : ""}` : ""}.
          </p>
          <p className="text-ink-300">
            Nada é apagado agora: tudo fica na <Link href="/trash" className="text-cyan-soft underline-offset-2 hover:underline">Lixeira</Link>, de onde dá para restaurar. Os arquivos continuam ocupando espaço até você excluí-los definitivamente.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Trocar o arquivo pede confirmação; o vídeo antigo vai para a Lixeira. */
export function RemoveMediaButton({ projectId, fileName, label = "Trocar arquivo" }: { projectId: string; fileName?: string; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} icon={<RefreshCw className="size-3.5" aria-hidden />}>
        {label}
      </Button>
      {open && (
        <ConfirmDialog
          title="Trocar o arquivo de vídeo?"
          confirmLabel="Mover vídeo para a lixeira"
          danger={false}
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            const result = await removeMediaAction(projectId);
            if (!result.ok) return result.error;
            setOpen(false);
            router.refresh();
            return null;
          }}
        >
          <p>
            {fileName ? (
              <>
                O vídeo <span className="font-semibold text-white">{fileName}</span>
              </>
            ) : (
              "O vídeo atual"
            )}{" "}
            vai para a Lixeira e o projeto volta a aguardar um arquivo. A transcrição já feita fica guardada na pasta do projeto.
          </p>
        </ConfirmDialog>
      )}
    </>
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

/** Recoloca na fila de seleção após uma falha, reaproveitando a transcrição. */
export function RetrySelectionButton({ projectId }: { projectId: string }) {
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
          const result = await retrySelectionAction(projectId);
          setPending(false);
          if (!result.ok) return setError(result.error);
          router.refresh();
        }}
      >
        Tentar selecionar de novo
      </Button>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

/** Descarta as sugestões atuais e pede outra rodada ao worker (confirmação em dois cliques). */
export function RegenerateClipsButton({ projectId, onDone }: { projectId: string; onDone?: () => void }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <div className="text-right">
      <Button
        variant={armed ? "danger" : "secondary"}
        disabled={pending}
        icon={pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
        onClick={async () => {
          if (!armed) return setArmed(true);
          setPending(true);
          const result = await regenerateClipsAction(projectId);
          setPending(false);
          setArmed(false);
          if (!result.ok) return setError(result.error);
          onDone?.();
          router.refresh();
        }}
      >
        {armed ? "Confirmar: descartar e gerar de novo" : "Gerar novas sugestões"}
      </Button>
      {armed && <p className="mt-1.5 text-xs text-amber-300">As sugestões e decisões atuais serão descartadas.</p>}
      {error && <p className="mt-1.5 text-xs text-rose-300">{error}</p>}
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
