import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";

export function ProjectNotFound() {
  return (
    <Card>
      <EmptyState
        icon={<SearchX className="size-6" />}
        title="Projeto não encontrado"
        description="Ele pode ter sido excluído. Os projetos ficam na pasta de dados local deste computador (.data/)."
        action={<ButtonLink href="/">Voltar ao dashboard</ButtonLink>}
      />
    </Card>
  );
}

export function ProjectSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando projeto">
      <div className="skeleton h-4 w-24 rounded" />
      <div className="skeleton h-9 w-2/3 rounded-lg" />
      <div className="skeleton h-40 rounded-2xl" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="skeleton h-56 rounded-2xl lg:col-span-2" />
        <div className="skeleton h-56 rounded-2xl" />
      </div>
    </div>
  );
}
