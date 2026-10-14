import type { ProjectStatus, StageId } from "./types";

/**
 * Máquina de estados dos projetos. É a única fonte de verdade sobre quais
 * mudanças de status são válidas — usada pelo servidor (store e API do worker)
 * e pela interface. Sem imports em tempo de execução para rodar em `node --test`.
 */

export const PROJECT_STATUSES: readonly ProjectStatus[] = ["awaiting_source", "transcribing", "selecting", "review", "rendering", "completed", "failed"];

export const TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  awaiting_source: ["transcribing", "failed"],
  // → awaiting_source: usuário remove o arquivo enquanto o job ainda está na fila.
  transcribing: ["selecting", "awaiting_source", "failed"],
  selecting: ["review", "failed"],
  // → selecting: pedir novas sugestões.
  review: ["rendering", "selecting"],
  rendering: ["completed", "failed"],
  // → review / rendering: ajustar e renderizar de novo.
  completed: ["review", "rendering"],
  // Repetir a etapa que falhou ou recomeçar com outro arquivo.
  failed: ["awaiting_source", "transcribing", "selecting", "rendering"],
};

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ProjectStatus, to: ProjectStatus) {
  return TRANSITIONS[from].includes(to);
}

/** Etapa do pipeline correspondente a cada status (falha usa `error.stage`). */
export const STATUS_STAGE: Record<Exclude<ProjectStatus, "failed" | "completed">, StageId> = {
  awaiting_source: "ingest",
  transcribing: "transcribe",
  selecting: "select",
  review: "review",
  rendering: "render",
};

/** Status em que um worker está (ou deveria estar) trabalhando. */
export const PROCESSING_STATUSES: readonly ProjectStatus[] = ["transcribing", "selecting", "rendering"];

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  awaiting_source: "Aguardando arquivo",
  transcribing: "Transcrição",
  selecting: "Seleção de cortes",
  review: "Revisão",
  rendering: "Renderização",
  completed: "Concluído",
  failed: "Falhou",
};
