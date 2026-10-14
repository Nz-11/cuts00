import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const base =
  "group/btn relative inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-all duration-300 ease-out select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-glow/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:pointer-events-none disabled:opacity-45";

const variants: Record<Variant, string> = {
  primary:
    "text-white bg-[linear-gradient(135deg,#7c3aed,#8b5cf6_45%,#0891b2)] bg-[length:160%_100%] bg-left hover:bg-right shadow-[0_8px_30px_-8px_rgb(139_92_246/0.6),inset_0_1px_0_rgb(255_255_255/0.2)] hover:shadow-[0_12px_40px_-8px_rgb(34_211_238/0.5),inset_0_1px_0_rgb(255_255_255/0.25)]",
  secondary:
    "text-ink-100 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] hover:border-white/20",
  ghost: "text-ink-200 hover:text-white hover:bg-white/[0.06]",
  danger: "text-rose-200 bg-rose-500/10 border border-rose-400/20 hover:bg-rose-500/20",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

interface StyleProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function Button({ variant = "primary", size = "md", icon, className, children, ...props }: StyleProps & ComponentProps<"button">) {
  return (
    <button className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function ButtonLink({ variant = "primary", size = "md", icon, className, children, ...props }: StyleProps & ComponentProps<typeof Link>) {
  return (
    <Link className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}
