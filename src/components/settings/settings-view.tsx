"use client";

import { AudioLines, Database, HardDrive, Palette, Plug, Scissors, Trash2, User } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Toggle } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/states";
import { VerticalPreview } from "@/components/review/vertical-preview";
import { cn } from "@/lib/format";
import { resetSettings, saveSettings, useHydrated, useSettings } from "@/lib/store";
import type { AppSettings, CaptionStyle } from "@/lib/types";

export interface IntegrationStatus {
  supabase: boolean;
  youtubeApi: boolean;
  workerApi: boolean;
  ffprobe: boolean;
  dataDir: string;
}

export function SettingsView({ integrations }: { integrations: IntegrationStatus }) {
  const hydrated = useHydrated();
  const settings = useSettings();
  const ids = useId();
  const [confirmClear, setConfirmClear] = useState(false);

  if (!hydrated) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-64 rounded-2xl" />
        ))}
      </div>
    );
  }

  const set = (patch: Partial<AppSettings>) => saveSettings({ ...settings, ...patch });
  const setCaption = (patch: Partial<CaptionStyle>) => set({ caption: { ...settings.caption, ...patch } });

  return (
    <div className="stagger grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader icon={<User className="size-4" />} title="Perfil e interface" />
        <div className="space-y-6 p-5 sm:p-6">
          <Field label="Seu nome" htmlFor={`${ids}-name`} hint="Exibido na saudação do dashboard.">
            <Input id={`${ids}-name`} value={settings.displayName} maxLength={40} onChange={(e) => set({ displayName: e.target.value })} />
          </Field>
          <Toggle
            id={`${ids}-demo`}
            label="Mostrar dados demonstrativos"
            description="Exibe projetos e estatísticas fictícios para explorar a interface. Desative para ver apenas seus projetos."
            checked={settings.showDemoData}
            onChange={(v) => set({ showDemoData: v })}
          />
        </div>
      </Card>

      <Card>
        <CardHeader icon={<AudioLines className="size-4" />} title="Transcrição" description="faster-whisper rodando localmente no worker (Python)." />
        <div className="space-y-6 p-5 sm:p-6">
          <Field label="Idioma do áudio" htmlFor={`${ids}-lang`}>
            <Select id={`${ids}-lang`} value={settings.language} onChange={(e) => set({ language: e.target.value as AppSettings["language"] })}>
              <option value="pt">Português</option>
              <option value="en">Inglês</option>
              <option value="es">Espanhol</option>
              <option value="auto">Detectar automaticamente</option>
            </Select>
          </Field>
          <Field label="Modelo Whisper" htmlFor={`${ids}-model`} hint="Modelos maiores são mais precisos, porém mais lentos e exigem mais memória.">
            <Select id={`${ids}-model`} value={settings.whisperModel} onChange={(e) => set({ whisperModel: e.target.value as AppSettings["whisperModel"] })}>
              <option value="tiny">tiny — mais rápido</option>
              <option value="base">base</option>
              <option value="small">small — equilíbrio recomendado</option>
              <option value="medium">medium — mais preciso</option>
            </Select>
          </Field>
          <p className="text-xs leading-relaxed text-ink-400">
            Estas escolhas ficam só neste navegador e ainda não são lidas pelo worker. O worker usa{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">CCA_WHISPER_MODEL</code> e{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">CCA_WHISPER_LANGUAGE</code> do <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">.env.local</code> (padrão: small, pt).
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Scissors className="size-4" />} title="Cortes" description="Limites usados pela IA ao sugerir trechos." />
        <div className="grid gap-6 p-5 sm:grid-cols-2 sm:p-6">
          <Field label="Duração mínima" htmlFor={`${ids}-min`} hint={`${settings.clipMinSec} segundos`}>
            <input id={`${ids}-min`} type="range" min={5} max={60} step={5} value={settings.clipMinSec} onChange={(e) => set({ clipMinSec: Math.min(Number(e.target.value), settings.clipMaxSec - 5) })} className="w-full" />
          </Field>
          <Field label="Duração máxima" htmlFor={`${ids}-max`} hint={`${settings.clipMaxSec} segundos`}>
            <input id={`${ids}-max`} type="range" min={15} max={180} step={5} value={settings.clipMaxSec} onChange={(e) => set({ clipMaxSec: Math.max(Number(e.target.value), settings.clipMinSec + 5) })} className="w-full" />
          </Field>
          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm sm:col-span-2">
            <span className="text-ink-300">Formato de saída</span>
            <span className="font-mono text-white">9:16 · 1080×1920 · MP4</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Plug className="size-4" />} title="Integrações" description="Opcionais. A interface funciona sem elas." />
        <ul className="divide-y divide-white/[0.05]">
          <IntegrationRow icon={<Database className="size-4" />} name="Supabase" detail="Autenticação e banco de dados" ok={integrations.supabase} />
          <IntegrationRow icon={<Plug className="size-4" />} name="YouTube oEmbed" detail="Confirma título e canal — gratuito, sem chave" ok pendingLabel="" okLabel="Ativo" />
          <IntegrationRow icon={<Plug className="size-4" />} name="YouTube Data API" detail="Metadados detalhados (opcional, cota gratuita)" ok={integrations.youtubeApi} />
          <IntegrationRow icon={<HardDrive className="size-4" />} name="ffprobe (FFmpeg)" detail="Valida os vídeos enviados" ok={integrations.ffprobe} pendingLabel="Não encontrado" okLabel="Encontrado" />
          <IntegrationRow icon={<HardDrive className="size-4" />} name="API do worker local" detail="Worker local de transcrição (faster-whisper + FFmpeg)" ok={integrations.workerApi} pendingLabel="Desligada" okLabel="Token definido" />
        </ul>
        <p className="px-5 pb-5 text-xs leading-relaxed text-ink-400 sm:px-6">
          Configure as chaves em <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">.env.local</code> (veja <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-ink-200">.env.example</code>). Chaves secretas ficam apenas no servidor.
        </p>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader icon={<Palette className="size-4" />} title="Estilo das legendas" description="Padrão aplicado aos novos cortes. A prévia atualiza em tempo real." />
        <div className="grid gap-8 p-5 sm:p-6 md:grid-cols-[1fr_220px]">
          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Fonte" htmlFor={`${ids}-font`}>
              <Select id={`${ids}-font`} value={settings.caption.fontFamily} onChange={(e) => setCaption({ fontFamily: e.target.value as CaptionStyle["fontFamily"] })}>
                <option value="Sora">Sora</option>
                <option value="Geist">Geist</option>
                <option value="Impact">Impact</option>
              </Select>
            </Field>
            <Field label="Tamanho" htmlFor={`${ids}-size`} hint={`${settings.caption.fontSize}px em 1080p`}>
              <input id={`${ids}-size`} type="range" min={32} max={72} step={2} value={settings.caption.fontSize} onChange={(e) => setCaption({ fontSize: Number(e.target.value) })} className="w-full" />
            </Field>
            <ColorField id={`${ids}-color`} label="Cor do texto" value={settings.caption.textColor} onChange={(v) => setCaption({ textColor: v })} />
            <ColorField id={`${ids}-hl`} label="Cor de destaque" value={settings.caption.highlightColor} onChange={(v) => setCaption({ highlightColor: v })} />
            <div className="space-y-2 sm:col-span-2">
              <p className="text-sm font-medium text-ink-100">Posição</p>
              <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/[0.06] bg-ink-900/80 p-1" role="radiogroup" aria-label="Posição da legenda">
                {(["top", "middle", "bottom"] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    role="radio"
                    aria-checked={settings.caption.position === pos}
                    onClick={() => setCaption({ position: pos })}
                    className={cn("rounded-lg py-2 text-sm font-medium transition-all", settings.caption.position === pos ? "bg-white/[0.08] text-white" : "text-ink-400 hover:text-ink-200")}
                  >
                    {pos === "top" ? "Topo" : pos === "middle" ? "Centro" : "Base"}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <Toggle id={`${ids}-upper`} label="Texto em maiúsculas" checked={settings.caption.uppercase} onChange={(v) => setCaption({ uppercase: v })} />
            </div>
          </div>
          <VerticalPreview caption={settings.caption} text="Isso mudou tudo no meu canal" className="mx-auto w-full max-w-[220px]" />
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="font-display text-[15px] font-semibold text-white">Onde ficam os dados</p>
            <p className="mt-1 text-sm text-ink-400">
              Projetos e vídeos enviados: <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-xs break-all text-ink-200">{integrations.dataDir}</code>. Nada é enviado para a nuvem.
            </p>
            <p className="mt-1 text-sm text-ink-400">Estas preferências ficam neste navegador. Restaurar não apaga projetos.</p>
          </div>
          {confirmClear ? (
            <div className="flex shrink-0 gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  resetSettings();
                  setConfirmClear(false);
                }}
              >
                Confirmar
              </Button>
              <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button variant="secondary" className="shrink-0" onClick={() => setConfirmClear(true)} icon={<Trash2 className="size-4" aria-hidden />}>
              Restaurar preferências
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function IntegrationRow({ icon, name, detail, ok, pendingLabel = "Não configurado", okLabel = "Configurado" }: { icon: ReactNode; name: string; detail: string; ok: boolean; pendingLabel?: string; okLabel?: string }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3.5 sm:px-6">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-ink-300 ring-1 ring-white/[0.06]">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{name}</p>
        <p className="text-xs text-ink-400">{detail}</p>
      </div>
      <Badge tone={ok ? "green" : "neutral"}>{ok ? okLabel : pendingLabel}</Badge>
    </li>
  );
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} htmlFor={id}>
      <div className="flex h-11 items-center gap-3 rounded-xl border border-white/10 bg-ink-900/80 px-2">
        <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-8 cursor-pointer rounded-lg border-0 bg-transparent p-0" />
        <span className="font-mono text-sm text-ink-200 uppercase">{value}</span>
      </div>
    </Field>
  );
}
