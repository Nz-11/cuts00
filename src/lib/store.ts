"use client";

import { useSyncExternalStore } from "react";
import type { AppSettings } from "./types";

/**
 * Preferências por navegador (localStorage). Os PROJETOS ficam no servidor
 * local (`.data/projects.json`, ver `src/server/project-store.ts`).
 */

const SETTINGS_KEY = "cca.settings.v1";
/** Chave usada pela v0.1, quando os projetos ficavam no navegador. */
const LEGACY_PROJECTS_KEY = "cca.projects.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  displayName: "Cezario",
  showDemoData: true,
  language: "pt",
  whisperModel: "small",
  clipMinSec: 20,
  clipMaxSec: 60,
  caption: {
    fontFamily: "Sora",
    fontSize: 46,
    textColor: "#ffffff",
    highlightColor: "#22d3ee",
    position: "bottom",
    uppercase: true,
  },
};

type Listener = () => void;

function createLocalValue<T>(key: string, fallback: T, parse: (raw: unknown) => T) {
  let cache: T | undefined;
  const listeners = new Set<Listener>();

  function read(): T {
    if (cache !== undefined) return cache;
    try {
      const raw = window.localStorage.getItem(key);
      cache = raw ? parse(JSON.parse(raw)) : fallback;
    } catch {
      cache = fallback;
    }
    return cache;
  }

  function write(next: T | undefined) {
    cache = next ?? fallback;
    try {
      if (next === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Armazenamento indisponível (modo privado/bloqueado): mantém só em memória.
    }
    listeners.forEach((l) => l());
  }

  function subscribe(listener: Listener) {
    listeners.add(listener);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        cache = undefined;
        listener();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  return { read, write, subscribe, fallback };
}

const settingsStore = createLocalValue<AppSettings>(SETTINGS_KEY, DEFAULT_SETTINGS, (raw) => {
  const value = (raw ?? {}) as Partial<AppSettings>;
  return { ...DEFAULT_SETTINGS, ...value, caption: { ...DEFAULT_SETTINGS.caption, ...value.caption } };
});

export interface LegacyProject {
  title: string;
  url?: string;
  createdAt?: string;
}

const EMPTY_LEGACY: LegacyProject[] = [];

const legacyStore = createLocalValue<LegacyProject[]>(LEGACY_PROJECTS_KEY, EMPTY_LEGACY, (raw) => {
  if (!Array.isArray(raw)) return EMPTY_LEGACY;
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => {
      const source = p.source as { kind?: string; url?: string; fileName?: string } | undefined;
      return {
        title: typeof p.title === "string" ? p.title : source?.fileName ?? "Projeto importado",
        url: source?.kind === "youtube" && typeof source.url === "string" ? source.url : undefined,
        createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
      };
    });
});

const noopSubscribe = () => () => {};

/** `false` durante a renderização no servidor e na hidratação; `true` depois. */
export function useHydrated() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export function useSettings() {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.read, () => settingsStore.fallback);
}

export function saveSettings(next: AppSettings) {
  settingsStore.write(next);
}

export function resetSettings() {
  settingsStore.write(undefined);
}

export function useLegacyProjects() {
  return useSyncExternalStore(legacyStore.subscribe, legacyStore.read, () => EMPTY_LEGACY);
}

export function clearLegacyProjects() {
  legacyStore.write(undefined);
}
