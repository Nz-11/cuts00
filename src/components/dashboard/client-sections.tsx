"use client";

import { FlaskConical, History, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProjectList } from "@/components/projects/project-list";
import { DemoBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Notice } from "@/components/ui/states";
import { DEMO_PROJECTS } from "@/lib/demo-data";
import { clearLegacyProjects, DEFAULT_SETTINGS, useHydrated, useLegacyProjects, useSettings } from "@/lib/store";
import { importLegacyProjectsAction } from "@/server/actions";

export function Greeting() {
  const hydrated = useHydrated();
  const { displayName } = useSettings();
  return <span className="text-gradient">{hydrated ? displayName || DEFAULT_SETTINGS.displayName : DEFAULT_SETTINGS.displayName}</span>;
}

/** Exemplos fictícios, em seção própria e claramente identificada. */
export function DemoSection() {
  const hydrated = useHydrated();
  const { showDemoData } = useSettings();
  if (!hydrated || !showDemoData) return null;

  return (
    <section aria-labelledby="demo-title" className="animate-fade-up">
      <Card className="overflow-hidden border-dashed! border-amber-400/20!">
        <CardHeader
          icon={<FlaskConical className="size-4" />}
          title={<span id="demo-title">Exemplos demonstrativos</span>}
          description="Projetos fictícios para explorar a interface. Não são seus e não foram processados."
          action={<DemoBadge />}
        />
        <ProjectList projects={DEMO_PROJECTS} basePath="/demo" />
      </Card>
    </section>
  );
}

/** Oferece importar rascunhos da v0.1, que ficavam salvos só no navegador. */
export function LegacyImport() {
  const legacy = useLegacyProjects();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (legacy.length === 0) return null;

  async function handleImport() {
    setPending(true);
    setError(null);
    const result = await importLegacyProjectsAction(legacy);
    setPending(false);
    if (!result.ok) return setError(result.error);
    clearLegacyProjects();
    router.refresh();
  }

  return (
    <Notice title={`${legacy.length} rascunho(s) da versão anterior encontrados neste navegador`} icon={<History className="size-4" />}>
      <p>Antes, os projetos ficavam só no navegador. Importe-os para a pasta de dados local para continuar de onde parou.</p>
      {error && <p className="mt-2 text-rose-300">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={handleImport} disabled={pending} icon={pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : undefined}>
          {pending ? "Importando…" : "Importar rascunhos"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => clearLegacyProjects()} disabled={pending}>
          Descartar
        </Button>
      </div>
    </Notice>
  );
}
