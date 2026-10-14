import { Cpu, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./logo";
import { MobileNav, SidebarNav } from "./nav";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-white/[0.05] bg-ink-950/60 px-4 py-6 backdrop-blur-xl lg:flex">
        <Link href="/" className="mb-10 px-2" aria-label="Cezario's Clips AI — início">
          <Logo />
        </Link>
        <p className="mb-2 px-3 text-[10px] font-semibold tracking-[0.2em] text-ink-500">ESTÚDIO</p>
        <SidebarNav />

        <div className="mt-auto space-y-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-100">
              <Cpu className="size-3.5 text-cyan-soft" aria-hidden />
              Processamento local
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-400">Whisper e FFmpeg rodando na sua máquina. Custo zero por vídeo.</p>
          </div>
          <div className="flex items-center gap-2 px-2 text-[11px] text-ink-500">
            <ShieldCheck className="size-3.5" aria-hidden />
            Apenas conteúdo autorizado
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center border-b border-white/[0.05] bg-ink-950/70 px-4 backdrop-blur-xl lg:hidden">
          <Link href="/" aria-label="Cezario's Clips AI — início">
            <Logo />
          </Link>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-32 sm:px-6 sm:pt-10 lg:px-10 lg:pb-16">{children}</main>
      </div>

      <MobileNav />
    </div>
  );
}
