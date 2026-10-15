"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

/** Tempo em que o botão de confirmar fica inativo após abrir: absorve cliques duplos. */
export const CONFIRM_ARM_MS = 800;

/**
 * Confirmação de ações destrutivas.
 * - abre num painel separado, longe do botão que o abriu;
 * - o botão de confirmar só funciona depois de CONFIRM_ARM_MS e, se `requireText`
 *   for passado, depois que o texto for digitado exatamente;
 * - uma ação em andamento ignora novos cliques; Esc ou "Cancelar" fecham.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  requireText,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  requireText?: string;
  danger?: boolean;
  /** Retorna uma mensagem de erro, ou null quando deu certo. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) {
  const inputId = useId();
  const titleId = useId();
  const [typed, setTyped] = useState("");
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    (requireText ? inputRef.current : cancelRef.current)?.focus();
    return () => clearTimeout(timer);
  }, [requireText]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matches = !requireText || typed.trim() === requireText.trim();
  const canConfirm = armed && matches && !pending;

  async function confirm() {
    if (!canConfirm || running.current) return;
    running.current = true;
    setPending(true);
    setError(null);
    const result = await onConfirm();
    running.current = false;
    setPending(false);
    if (result) setError(result);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/80 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && !running.current && onClose()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="surface w-full max-w-md rounded-2xl p-5 sm:p-6">
        <h2 id={titleId} className="flex items-center gap-2 font-display text-lg font-semibold text-white">
          <AlertTriangle className={danger ? "size-5 text-rose-300" : "size-5 text-amber-300"} aria-hidden /> {title}
        </h2>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink-200">{children}</div>
        {requireText && (
          <div className="mt-4">
            <label htmlFor={inputId} className="text-xs text-ink-300">
              Para confirmar, digite <span className="font-semibold text-white">{requireText}</span>
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirm()}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              className="mt-1.5 h-10 w-full rounded-lg border border-white/10 bg-ink-950 px-3 text-sm text-white focus:border-rose-400/60 focus:ring-2 focus:ring-rose-400/20 focus:outline-none"
            />
          </div>
        )}
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} disabled={!canConfirm} icon={pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : undefined}>
            {pending ? "Aguarde…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
