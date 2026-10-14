import type { Metadata } from "next";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { PageHeader } from "@/components/ui/states";

export const metadata: Metadata = { title: "Novo projeto" };

export default function NewProjectPage() {
  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Novo projeto" title="De vídeo longo a cortes virais" description="Informe o vídeo de origem. Usamos apenas conteúdo que você tem direito de utilizar." />
      <NewProjectForm />
    </div>
  );
}
