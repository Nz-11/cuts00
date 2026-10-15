import path from "node:path";

/** Pasta de dados local e erros do armazenamento (compartilhados por project-store e trash). */

export type StoreErrorCode = "not_found" | "invalid_transition" | "corrupted";

export class StoreError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function dataDir() {
  return path.resolve(process.env.CCA_DATA_DIR || path.join(process.cwd(), ".data"));
}

/** Pasta dos arquivos de um projeto, relativa à pasta de dados. */
export function projectMediaDir(id: string) {
  return path.join("media", id);
}

export function resolveDataPath(relative: string) {
  const full = path.resolve(dataDir(), relative);
  if (!full.startsWith(dataDir() + path.sep)) throw new Error("Caminho fora da pasta de dados.");
  return full;
}
