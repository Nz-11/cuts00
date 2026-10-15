import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaFile, Project } from "../lib/types";
import { dataDir, projectMediaDir, resolveDataPath, StoreError } from "./data-paths.ts";

/**
 * Lixeira local: "excluir" um projeto (ou trocar o arquivo de vídeo) MOVE os
 * arquivos para `.data/trash/<item>/`, em vez de apagá-los. A mudança é um
 * `rename` na mesma pasta de dados: instantânea, sem cópia e sem risco de
 * corromper o vídeo. Nada sai da lixeira sozinho; só "Excluir definitivamente"
 * apaga, com confirmação explícita.
 *
 * Cada item:
 *   .data/trash/<id>/entry.json   ficha do item (projeto ou arquivo, data, tamanho)
 *   .data/trash/<id>/files/       arquivos movidos (pasta de mídia ou o vídeo trocado)
 */

export type TrashKind = "project" | "media";

export interface TrashEntry {
  version: 1;
  id: string;
  kind: TrashKind;
  projectId: string;
  title: string;
  deletedAt: string;
  /** Projeto completo (kind "project"), para restaurar exatamente como estava. */
  project?: Project;
  /** Arquivo trocado (kind "media"). */
  media?: MediaFile;
  /** Tamanho dos arquivos guardados, calculado na listagem. */
  sizeBytes?: number;
}

const ENTRY_ID_RE = /^p_[A-Za-z0-9_-]{1,64}-\d{13}$/;

export function trashDir() {
  return path.join(dataDir(), "trash");
}

export function isTrashEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID_RE.test(value);
}

function entryDir(entryId: string) {
  if (!isTrashEntryId(entryId)) throw new StoreError("not_found", "Item da lixeira inválido.");
  return path.join(trashDir(), entryId);
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(p: string): Promise<number> {
  const info = await stat(p).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const names = await readdir(p);
  let total = 0;
  for (const name of names) total += await sizeOf(path.join(p, name));
  return total;
}

/** No Windows, um arquivo aberto (worker processando, player tocando) impede a movimentação. */
function busyMessage(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES"
    ? "Os arquivos estão em uso (o worker pode estar processando ou um player tocando este vídeo). Feche o worker ou espere ele terminar e tente de novo."
    : null;
}

/**
 * Cria o item e move `source` (pasta ou arquivo) para dentro dele.
 * Se a movimentação falhar, o item é desfeito e nada muda.
 */
export async function moveToTrash(entry: Omit<TrashEntry, "version" | "id" | "deletedAt">, source: string | null): Promise<TrashEntry> {
  const now = new Date();
  const full: TrashEntry = { version: 1, id: `${entry.projectId}-${now.getTime()}`, deletedAt: now.toISOString(), ...entry };
  const dir = entryDir(full.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "entry.json"), JSON.stringify(full, null, 2), "utf8");
  if (source && (await exists(source))) {
    // Projeto: a pasta de mídia inteira vira `files/`. Vídeo trocado: vai para `files/<nome>`.
    const target = entry.kind === "media" ? path.join(dir, "files", path.basename(source)) : path.join(dir, "files");
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }); // só a ficha recém-criada
      throw new StoreError("invalid_transition", busyMessage(err) ?? `Não foi possível mover os arquivos para a lixeira: ${(err as Error).message}`);
    }
  }
  return full;
}

export async function listTrash(): Promise<TrashEntry[]> {
  const names = await readdir(trashDir()).catch(() => [] as string[]);
  const entries: TrashEntry[] = [];
  for (const name of names) {
    if (!isTrashEntryId(name)) continue;
    try {
      const entry = JSON.parse(await readFile(path.join(trashDir(), name, "entry.json"), "utf8")) as TrashEntry;
      if (entry.version !== 1 || entry.id !== name) continue;
      entries.push({ ...entry, sizeBytes: await sizeOf(path.join(trashDir(), name, "files")) });
    } catch {
      // Ficha ilegível: o item é ignorado na lista, mas nada é apagado.
    }
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function getTrashEntry(entryId: string): Promise<TrashEntry | undefined> {
  try {
    const entry = JSON.parse(await readFile(path.join(entryDir(entryId), "entry.json"), "utf8")) as TrashEntry;
    return entry.version === 1 && entry.id === entryId ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Devolve os arquivos de um projeto excluído para `media/<id>`. A ficha é removida depois. */
export async function restoreProjectFiles(entry: TrashEntry): Promise<void> {
  const dir = entryDir(entry.id);
  const target = resolveDataPath(projectMediaDir(entry.projectId));
  if (await exists(target)) throw new StoreError("invalid_transition", "Já existe uma pasta de mídia para este projeto; nada foi alterado.");
  if (await exists(path.join(dir, "files"))) {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(path.join(dir, "files"), target);
    } catch (err) {
      throw new StoreError("invalid_transition", busyMessage(err) ?? `Não foi possível restaurar os arquivos: ${(err as Error).message}`);
    }
  }
}

/** Devolve um vídeo trocado para o lugar original (`media/<id>/<arquivo>`). */
export async function restoreMediaFile(entry: TrashEntry): Promise<void> {
  if (!entry.media) throw new StoreError("not_found", "Item sem arquivo de vídeo.");
  const source = path.join(entryDir(entry.id), "files", path.basename(entry.media.storedPath));
  const target = resolveDataPath(entry.media.storedPath);
  if (await exists(target)) throw new StoreError("invalid_transition", "Já existe um arquivo com esse nome na pasta do projeto; nada foi alterado.");
  if (!(await exists(source))) throw new StoreError("not_found", "O arquivo não está mais na lixeira.");
  await mkdir(path.dirname(target), { recursive: true });
  await rename(source, target);
}

/** Remove a ficha de um item já restaurado (a pasta `files` já foi devolvida). */
export async function dropTrashEntry(entryId: string): Promise<void> {
  const dir = entryDir(entryId);
  if (await exists(path.join(dir, "files"))) {
    const left = await readdir(path.join(dir, "files"));
    if (left.length) throw new StoreError("invalid_transition", "Ainda há arquivos neste item da lixeira; nada foi apagado.");
  }
  await rm(dir, { recursive: true, force: true });
}

/** Exclusão definitiva de um item da lixeira (irreversível). */
export async function purgeTrashEntry(entryId: string): Promise<void> {
  const dir = entryDir(entryId);
  if (!(await exists(dir))) throw new StoreError("not_found", "Item da lixeira não encontrado.");
  await rm(dir, { recursive: true, force: true });
}

/** O nome digitado precisa ser igual ao do item (ignora espaços nas pontas). */
export function confirmsTitle(typed: unknown, title: string) {
  return typeof typed === "string" && typed.trim().length > 0 && typed.trim() === title.trim();
}
