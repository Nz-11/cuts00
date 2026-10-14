import { cn } from "@/lib/format";

/** Marca: quadro vertical 9:16 cortado por uma lâmina diagonal. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="cca-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#0f0f15" stroke="url(#cca-g)" strokeOpacity=".55" />
      <rect x="10.5" y="6.5" width="11" height="19" rx="2.6" fill="none" stroke="url(#cca-g)" strokeWidth="2" />
      <path d="M6 22.5 26 9.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="26" cy="9.5" r="2" fill="#22d3ee" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      {!compact && (
        <span className="leading-none">
          <span className="block font-display text-[15px] font-semibold tracking-tight text-white">Cezario&apos;s Clips</span>
          <span className="mt-1 block text-[10px] font-medium tracking-[0.28em] text-cyan-soft/80">AI STUDIO</span>
        </span>
      )}
    </span>
  );
}
