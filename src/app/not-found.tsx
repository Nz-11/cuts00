import { SearchX } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";

export default function NotFound() {
  return (
    <AppShell>
      <Card>
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="Página não encontrada"
          description="O endereço acessado não existe ou foi removido."
          action={<ButtonLink href="/">Voltar ao dashboard</ButtonLink>}
        />
      </Card>
    </AppShell>
  );
}
