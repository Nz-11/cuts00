"use client";

import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";

export default function StudioError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card>
      <ErrorState
        title="Não foi possível carregar esta página"
        description="Ocorreu um erro inesperado. Tente novamente; se persistir, volte ao dashboard."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => retry()} icon={<RotateCcw className="size-4" aria-hidden />}>
              Tentar novamente
            </Button>
            <ButtonLink href="/" variant="secondary">
              Ir ao dashboard
            </ButtonLink>
          </div>
        }
      />
    </Card>
  );
}
