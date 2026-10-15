import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { SettingsView } from "@/components/settings/settings-view";
import { PageHeader, Skeleton } from "@/components/ui/states";
import { isFfprobeAvailable } from "@/server/media";
import { isOllamaRunning } from "@/server/ollama-status";
import { dataDir } from "@/server/project-store";

export const metadata: Metadata = { title: "Configurações" };

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Configurações" title="Preferências do estúdio" description="Ajustes salvos automaticamente neste navegador." />
      <Suspense fallback={<Skeleton className="h-96 rounded-2xl" />}>
        <SettingsLoader />
      </Suspense>
    </div>
  );
}

async function SettingsLoader() {
  await connection();
  // Apenas a presença das variáveis é enviada ao navegador — nunca os valores.
  const integrations = {
    supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    youtubeApi: Boolean(process.env.YOUTUBE_API_KEY),
    workerApi: Boolean(process.env.CCA_WORKER_TOKEN),
    ffprobe: await isFfprobeAvailable(),
    ollama: await isOllamaRunning(),
    dataDir: dataDir(),
  };
  return <SettingsView integrations={integrations} />;
}
