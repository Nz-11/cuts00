"use client";

/* eslint-disable @next/next/no-img-element -- miniatura pública do YouTube */
import { ArrowRight, FileVideo, Link2, Loader2, ShieldCheck, UploadCloud, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/states";
import { cn, formatBytes } from "@/lib/format";
import { uploadProjectMedia } from "@/lib/upload-client";
import { parseYouTubeVideoId, youTubeThumbnail } from "@/lib/youtube";
import { createFileProjectAction, createYouTubeProjectAction } from "@/server/actions";

type Mode = "youtube" | "file";

const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];

export function NewProjectForm() {
  const router = useRouter();
  const ids = useId();
  const [mode, setMode] = useState<Mode>("youtube");
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [rights, setRights] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "saving" | "uploading">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [serverError, setServerError] = useState<{ message: string; field?: string; existingId?: string; projectId?: string } | null>(null);

  const videoId = parseYouTubeVideoId(url);
  const urlClientError = !url.trim() ? "Cole o link de um vídeo do YouTube." : !videoId ? "Link inválido. Use um endereço como youtube.com/watch?v=… ou youtu.be/…" : null;
  const urlError = mode === "youtube" ? ((urlTouched || submitted) && urlClientError) || (serverError?.field === "url" ? serverError.message : null) : null;
  const fileExtOk = !file || ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
  const fileError = mode === "file" ? (submitted && !file ? "Selecione um arquivo de vídeo." : !fileExtOk ? `Formato não suportado. Use ${ACCEPTED_EXTENSIONS.join(", ")}.` : null) : null;
  const rightsError = submitted && !rights ? "Confirme que você tem direito de usar este conteúdo." : null;
  const busy = phase !== "idle";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (!rights) return;

    if (mode === "youtube") {
      if (urlClientError) return;
      setPhase("saving");
      const result = await createYouTubeProjectAction({ url, title, rightsConfirmed: rights });
      if (!result.ok) {
        setPhase("idle");
        return setServerError({ message: result.error, field: result.field, existingId: result.existingId });
      }
      return router.push(`/projects/${result.id}`);
    }

    if (!file || !fileExtOk) return;
    setPhase("saving");
    const created = await createFileProjectAction({ title, fileName: file.name, rightsConfirmed: rights });
    if (!created.ok) {
      setPhase("idle");
      return setServerError({ message: created.error });
    }
    setPhase("uploading");
    setUploadProgress(0);
    const upload = await uploadProjectMedia(created.id, file, setUploadProgress);
    if (!upload.ok) {
      setPhase("idle");
      return setServerError({ message: upload.error, projectId: created.id });
    }
    router.push(`/projects/${created.id}`);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4 lg:grid-cols-5">
      <Card className="p-5 sm:p-7 lg:col-span-3">
        <div role="tablist" aria-label="Origem do vídeo" className="mb-7 grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-ink-900/80 p-1">
          {(
            [
              { value: "youtube", label: "Link do YouTube", icon: Link2 },
              { value: "file", label: "Arquivo de vídeo", icon: FileVideo },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-300",
                mode === value ? "bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" : "text-ink-400 hover:text-ink-200",
              )}
            >
              <Icon className={cn("size-4", mode === value && "text-cyan-soft")} aria-hidden />
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {mode === "youtube" ? (
            <Field label="Link do vídeo" htmlFor={`${ids}-url`} error={urlError} hint="Vídeos do seu próprio canal ou com autorização do titular.">
              <Input
                id={`${ids}-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setServerError(null);
                }}
                onBlur={() => setUrlTouched(true)}
                aria-invalid={!!urlError}
                aria-describedby={urlError ? `${ids}-url-error` : undefined}
              />
            </Field>
          ) : (
            <Field label="Arquivo de vídeo" htmlFor={`${ids}-file`} error={fileError}>
              {file ? (
                <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-ink-900/80 p-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-glow/15 text-violet-soft">
                    <FileVideo className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{file.name}</p>
                    <p className="text-xs text-ink-400">{formatBytes(file.size)}</p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setFile(null)} aria-label="Remover arquivo">
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              ) : (
                <label
                  htmlFor={`${ids}-file`}
                  className={cn(
                    "group flex cursor-pointer flex-col items-center rounded-2xl border border-dashed px-6 py-10 text-center transition-all duration-300 hover:border-violet-glow/50 hover:bg-violet-glow/[0.04]",
                    fileError ? "border-rose-400/50" : "border-white/15",
                  )}
                >
                  <UploadCloud className="size-8 text-ink-400 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:text-violet-soft" aria-hidden />
                  <span className="mt-3 text-sm font-medium text-white">Escolher arquivo</span>
                  <span className="mt-1 text-xs text-ink-400">MP4, MOV, MKV ou WebM</span>
                </label>
              )}
              <input
                id={`${ids}-file`}
                type="file"
                accept={ACCEPTED_EXTENSIONS.join(",")}
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </Field>
          )}

          <Field label="Nome do projeto" htmlFor={`${ids}-title`} hint="Opcional. Usado apenas para organizar seus projetos.">
            <Input id={`${ids}-title`} placeholder="Ex.: Podcast #43 — convidado especial" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>

          <div>
            <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors", rightsError ? "border-rose-400/40 bg-rose-500/[0.04]" : "border-white/[0.08] bg-white/[0.02] hover:border-white/15")}>
              <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-violet-glow" aria-invalid={!!rightsError} />
              <span className="text-sm leading-relaxed text-ink-200">
                <span className="flex items-center gap-1.5 font-medium text-white">
                  <ShieldCheck className="size-4 text-cyan-soft" aria-hidden />
                  Tenho direito de usar este conteúdo
                </span>
                Sou o titular do vídeo ou tenho autorização para criar e publicar cortes a partir dele.
              </span>
            </label>
            {rightsError && (
              <p className="mt-2 text-xs text-rose-300" role="alert">
                {rightsError}
              </p>
            )}
          </div>

          {serverError && serverError.field !== "url" && (
            <Notice tone="warning">
              {serverError.message}
              {serverError.projectId && (
                <>
                  {" "}O projeto foi criado; você pode reenviar o arquivo na{" "}
                  <Link href={`/projects/${serverError.projectId}`} className="font-medium text-white underline underline-offset-2">
                    página do projeto
                  </Link>
                  .
                </>
              )}
            </Notice>
          )}
          {serverError?.existingId && (
            <Link href={`/projects/${serverError.existingId}`} className="-mt-3 inline-flex items-center gap-1 text-sm font-medium text-cyan-soft hover:text-white">
              Abrir projeto existente <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}

          {phase === "uploading" && (
            <div aria-live="polite">
              <div className="mb-1.5 flex justify-between text-xs text-ink-300">
                <span>{uploadProgress < 1 ? "Enviando arquivo para a pasta local…" : "Verificando o vídeo com ffprobe…"}</span>
                <span className="font-mono tabular-nums">{Math.round(uploadProgress * 100)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-glow to-cyan-glow transition-[width] duration-300" style={{ width: `${uploadProgress * 100}%` }} />
              </div>
            </div>
          )}

          <Button type="submit" size="lg" className="w-full" disabled={busy} icon={busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : undefined}>
            {phase === "saving" ? (mode === "youtube" ? "Verificando vídeo…" : "Criando projeto…") : phase === "uploading" ? "Enviando…" : "Criar projeto"}
            {!busy && <ArrowRight className="size-4 transition-transform group-hover/btn:translate-x-0.5" aria-hidden />}
          </Button>
        </div>
      </Card>

      <div className="space-y-4 lg:col-span-2">
        <Card className="overflow-hidden">
          <div className="relative aspect-video bg-ink-900">
            {mode === "youtube" && videoId ? (
              <img key={videoId} src={youTubeThumbnail(videoId)} alt="Miniatura do vídeo" className="size-full animate-fade-up object-cover" />
            ) : (
              <div className="grid size-full place-items-center">
                <div className="text-center">
                  {mode === "youtube" ? <Link2 className="mx-auto size-7 text-ink-500" aria-hidden /> : <FileVideo className="mx-auto size-7 text-ink-500" aria-hidden />}
                  <p className="mt-2 text-xs text-ink-400">{mode === "youtube" ? "A miniatura aparece aqui" : file ? file.name : "Nenhum arquivo selecionado"}</p>
                </div>
              </div>
            )}
          </div>
          <div className="p-5 text-sm">
            <p className="font-medium text-white">Pré-visualização</p>
            <p className="mt-1 text-ink-400">
              {mode === "youtube" ? (videoId ? `ID do vídeo: ${videoId}` : "Cole um link válido para ver a miniatura.") : "O arquivo é copiado para a pasta de dados local (.data/) — não sai do seu computador."}
            </p>
          </div>
        </Card>

        {mode === "youtube" ? (
          <Notice tone="warning" title="Sobre links do YouTube">
            Não baixamos vídeos do YouTube. O link identifica o vídeo e o título é confirmado pelo oEmbed oficial. Para gerar cortes, você enviará depois o arquivo original (ex.: exportado do seu editor ou baixado do seu próprio canal no YouTube Studio).
          </Notice>
        ) : (
          <Notice title="O que acontece depois do envio">
            O vídeo é validado com o ffprobe (duração, vídeo e áudio) e entra na fila de <strong className="text-white">transcrição</strong>. A transcrição roda no worker local (faster-whisper) quando ele estiver ligado; enquanto isso, o projeto aguarda na fila.
          </Notice>
        )}
      </div>
    </form>
  );
}
