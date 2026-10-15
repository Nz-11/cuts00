"use client";

import { LayoutDashboard, Plus, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { cn } from "@/lib/format";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, match: (p: string) => p === "/" || p.startsWith("/demo/") || (p.startsWith("/projects/") && p !== "/projects/new") },
  { href: "/projects/new", label: "Novo projeto", icon: Plus, match: (p: string) => p === "/projects/new" },
  { href: "/settings", label: "Configurações", icon: Settings, match: (p: string) => p.startsWith("/settings") },
  { href: "/trash", label: "Lixeira", icon: Trash2, match: (p: string) => p.startsWith("/trash") },
];

/** Links renderizados no shell estático; o estado ativo chega via Suspense. */
export function SidebarNav() {
  return (
    <Suspense fallback={<SidebarLinks pathname="" />}>
      <ActiveSidebarLinks />
    </Suspense>
  );
}

function ActiveSidebarLinks() {
  return <SidebarLinks pathname={usePathname()} />;
}

function SidebarLinks({ pathname }: { pathname: string }) {
  return (
    <nav className="space-y-1" aria-label="Principal">
      {NAV_ITEMS.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-300",
              active ? "bg-white/[0.06] text-white" : "text-ink-300 hover:bg-white/[0.03] hover:text-ink-100",
            )}
          >
            <span
              className={cn(
                "absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-b from-violet-soft to-cyan-glow transition-opacity duration-300",
                active ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
            <Icon className={cn("size-[18px] transition-colors", active ? "text-cyan-soft" : "text-ink-400 group-hover:text-ink-200")} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function MobileNav() {
  return (
    <Suspense fallback={<MobileLinks pathname="" />}>
      <ActiveMobileLinks />
    </Suspense>
  );
}

function ActiveMobileLinks() {
  return <MobileLinks pathname={usePathname()} />;
}

function MobileLinks({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Principal"
      className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-2xl border border-white/10 bg-ink-900/85 p-1.5 shadow-[0_20px_50px_-10px_rgb(0_0_0/0.9)] backdrop-blur-xl lg:hidden"
      style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
    >
      {NAV_ITEMS.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        const primary = href === "/projects/new";
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 text-[11px] font-medium transition-colors",
              active ? "text-white" : "text-ink-400",
            )}
          >
            <span
              className={cn(
                "grid size-8 place-items-center rounded-lg transition-all",
                primary && "bg-gradient-to-br from-violet-glow to-cyan-glow/80 text-white shadow-[0_6px_20px_-6px_rgb(139_92_246/0.8)]",
                !primary && active && "bg-white/[0.08] text-cyan-soft",
              )}
            >
              <Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
