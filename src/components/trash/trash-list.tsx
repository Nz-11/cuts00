"use client";

import { FileVideo, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/states";
import { formatBytes, formatDate } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/project-status";
import type { ProjectStatus } from "@/lib/types";
import { purgeTrashAction, restoreTrashAction } from "@/server/actions";

export interface TrashItem {
  id: string;
  kind: "project" | "media";
  title: string;
  projectId: string;
  deletedAt: string;
  sizeBytes: number;
  status?: ProjectStatus;
  clips: number;
}

export function TrashList({ entries }: { entries: TrashItem[] }) {
  const router = useRouter();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const total = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  if (!entries.length) {
    return (
      <Card>
        <EmptyState icon={<Trash2 className="size-6" />} title="A lixeira está vazia" description="Projetos excluídos e vídeos trocados aparecem aqui e podem ser restaurados." />
      </Card>
    );
  }

  async function restore(item: TrashItem) {
    if (restoring) return;
    setRestoring(item.id);
    setError(null);
    const result = await restoreTrashAction(item.id);
    setRestoring(null);
    if (!result.ok) return setError({ id: item.id, message: result.error });
    router.push(`/projects/${result.projectId}`);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-300">
        {entries.length} {entries.length > 1 ? "itens ocupam" : "item ocupa"} <span className="font-medium text-white">{formatBytes(total)}</span> no disco. Nada sai daqui
        sozinho.
      </p>
      <ul className="space-y-3">
        {entries.map((item) => (
          <li key={item.id}>
            <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-ink-300 ring-1 ring-white/[0.06]">
                  {item.kind === "project" ? <FolderOpen className="size-4" aria-hidden /> : <FileVideo className="size-4" aria-hidden />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{item.title}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {item.kind === "project" ? `Projeto${item.status ? ` · ${STATUS_LABEL[item.status]}` : ""}${item.clips ? ` · ${item.clips} cortes` : ""}` : "Vídeo trocado"} · excluído em{" "}
                    {formatDate(item.deletedAt)} · {formatBytes(item.sizeBytes)}
                  </p>
                  {error?.id === item.id && <p className="mt-1.5 text-xs text-rose-300">{error.message}</p>}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={restoring !== null} onClick={() => restore(item)} icon={<RotateCcw className="size-3.5" aria-hidden />}>
                  {restoring === item.id ? "Restaurando…" : "Restaurar"}
                </Button>
                <Button size="sm" variant="ghost" disabled={restoring !== null} onClick={() => setPurging(item)} icon={<Trash2 className="size-3.5" aria-hidden />}>
                  Excluir definitivamente
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {purging && (
        <ConfirmDialog
          title="Excluir definitivamente?"
          confirmLabel="Excluir para sempre"
          requireText={purging.title}
          onClose={() => setPurging(null)}
          onConfirm={async () => {
            const result = await purgeTrashAction(purging.id, purging.title);
            if (!result.ok) return result.error;
            setPurging(null);
            router.refresh();
            return null;
          }}
        >
          <p>
            Os arquivos de <span className="font-semibold text-white">{purging.title}</span> ({formatBytes(purging.sizeBytes)}) serão apagados do disco.{" "}
            <span className="font-semibold text-rose-200">Isso não pode ser desfeito.</span>
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
