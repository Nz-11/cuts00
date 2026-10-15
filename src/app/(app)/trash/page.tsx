import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { TrashList } from "@/components/trash/trash-list";
import { PageHeader, Skeleton } from "@/components/ui/states";
import { listTrash } from "@/server/trash";

export const metadata: Metadata = { title: "Lixeira" };

export default function TrashPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Lixeira"
        title="Projetos e vídeos removidos"
        description="Itens excluídos ficam aqui, com todos os arquivos, até você restaurá-los ou excluí-los definitivamente."
      />
      <Suspense fallback={<Skeleton className="h-64 rounded-2xl" />}>
        <TrashLoader />
      </Suspense>
    </div>
  );
}

async function TrashLoader() {
  await connection();
  const entries = await listTrash();
  // Só o necessário vai para o navegador (sem caminhos do disco).
  return (
    <TrashList
      entries={entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        projectId: e.projectId,
        deletedAt: e.deletedAt,
        sizeBytes: e.sizeBytes ?? 0,
        status: e.project?.status,
        clips: e.project?.clips.length ?? 0,
      }))}
    />
  );
}
