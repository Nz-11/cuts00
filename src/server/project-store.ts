import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipRender, JobInfo, Project, ProjectStatus, StageId, YouTubeRef } from "../lib/types";
import { canTransition, PROCESSING_STATUSES } from "../lib/project-status.ts";
import { dataDir, projectMediaDir, resolveDataPath, StoreError } from "./data-paths.ts";
import { dropTrashEntry, getTrashEntry, moveToTrash, restoreProjectFiles, type TrashEntry } from "./trash.ts";

export { dataDir, projectMediaDir, resolveDataPath, StoreError };
export type { StoreErrorCode } from "./data-paths.ts";

/**
 * Persistência local do protótipo: um arquivo JSON na pasta de dados
 * (padrão `.data/`, configurável por CCA_DATA_DIR). Roda só no servidor.
 *
 * - Escritas são serializadas numa fila e gravadas de forma atômica
 *   (arquivo temporário + rename), evitando JSON corrompido.
 * - Não há nuvem: os dados ficam apenas neste computador.
 * - Para virar SaaS, troca-se este módulo por um repositório Supabase com as
 *   mesmas funções.
 */

interface Database {
  version: 1;
  projects: Project[];
}

const dbFile = () => path.join(dataDir(), "projects.json");

async function readDb(): Promise<Database> {
  let raw: string;
  try {
    raw = await readFile(dbFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [] };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Database;
    if (!Array.isArray(parsed.projects)) throw new Error("formato inválido");
    return parsed;
  } catch {
    throw new StoreError("corrupted", `O arquivo de dados ${dbFile()} está corrompido. Restaure um backup ou remova-o para começar do zero.`);
  }
}

async function writeDb(db: Database) {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${dbFile()}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  // No Windows o rename pode falhar momentaneamente (antivírus/indexador).
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, dbFile());
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Executa leitura-modificação-escrita com exclusividade. */
function mutate<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Leituras aguardam escritas pendentes para nunca ver estado intermediário. */
async function read() {
  await queue;
  return readDb();
}

function find(db: Database, id: string) {
  const project = db.projects.find((p) => p.id === id);
  if (!project) throw new StoreError("not_found", "Projeto não encontrado.");
  return project;
}

export async function listProjects(): Promise<Project[]> {
  const db = await read();
  return [...db.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await read();
  return db.projects.find((p) => p.id === id);
}

export async function findProjectByVideoId(videoId: string): Promise<Project | undefined> {
  const db = await read();
  return db.projects.find((p) => p.youtube?.videoId === videoId);
}

export async function createProject(input: { title: string; youtube?: YouTubeRef; createdAt?: string }): Promise<Project> {
  return mutate((db) => {
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const project: Project = {
      id: `p_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      title: input.title,
      youtube: input.youtube,
      status: "awaiting_source",
      createdAt,
      updatedAt: now,
      rightsConfirmedAt: now,
      clips: [],
      history: [{ status: "awaiting_source", at: createdAt, note: "Projeto criado" }],
    };
    db.projects.push(project);
    return project;
  });
}

/** Altera campos que não são de status (título, mídia, cortes). */
export async function updateProject(id: string, fn: (project: Project) => void): Promise<Project> {
  return mutate((db) => {
    const project = find(db, id);
    const { status } = project;
    fn(project);
    if (project.status !== status) throw new Error("Use transitionProject para mudar o status.");
    project.updatedAt = new Date().toISOString();
    return structuredClone(project);
  });
}

export interface TransitionOptions {
  note?: string;
  job?: Partial<Omit<JobInfo, "updatedAt">>;
  error?: { stage: StageId; message: string };
  /** Alterações extras aplicadas na mesma escrita (ex.: anexar mídia). */
  apply?: (project: Project) => void;
}

export async function transitionProject(id: string, to: ProjectStatus, options: TransitionOptions = {}): Promise<Project> {
  return mutate((db) => {
    const project = find(db, id);
    if (!canTransition(project.status, to)) {
      throw new StoreError("invalid_transition", `Transição inválida: ${project.status} → ${to}.`);
    }
    if (to === "failed" && !options.error) throw new Error("Falha exige `error`.");

    const now = new Date().toISOString();
    options.apply?.(project);
    project.status = to;
    project.updatedAt = now;
    project.history.push({ status: to, at: now, note: options.note });
    project.error = to === "failed" ? options.error : undefined;
    project.job = PROCESSING_STATUSES.includes(to) ? { state: "queued", progress: 0, ...options.job, updatedAt: now } : undefined;
    return structuredClone(project);
  });
}

/** Atualiza o progresso do job atual sem mudar o status (usado pelo worker). */
export async function updateJob(id: string, job: Partial<Omit<JobInfo, "updatedAt">>): Promise<Project> {
  return mutate((db) => {
    const project = find(db, id);
    if (!PROCESSING_STATUSES.includes(project.status) || !project.job) {
      throw new StoreError("invalid_transition", `O projeto não está em processamento (status: ${project.status}).`);
    }
    const now = new Date().toISOString();
    project.job = { ...project.job, ...job, updatedAt: now };
    project.updatedAt = now;
    return structuredClone(project);
  });
}

/** Atualiza a renderização de um corte (usado pelo worker durante `rendering`). */
export async function updateClipRender(id: string, clipId: string, patch: Partial<Omit<ClipRender, "requestedAt" | "framing" | "captions" | "startSec" | "endSec">>): Promise<Project> {
  return mutate((db) => {
    const project = find(db, id);
    if (project.status !== "rendering") throw new StoreError("invalid_transition", `O projeto não está renderizando (status: ${project.status}).`);
    const clip = project.clips.find((c) => c.id === clipId);
    if (!clip?.render) throw new StoreError("not_found", "Corte sem renderização pedida.");
    const now = new Date().toISOString();
    clip.render = { ...clip.render, ...patch, updatedAt: now };
    if (patch.state && patch.state !== "failed") delete clip.render.error;
    project.updatedAt = now;
    return structuredClone(project);
  });
}

/**
 * "Exclui" um projeto movendo-o, com todos os arquivos, para a lixeira (`trash.ts`).
 * Se os arquivos não puderem ser movidos (em uso), nada muda.
 */
export async function deleteProject(id: string): Promise<TrashEntry> {
  return mutate(async (db) => {
    const project = find(db, id);
    const entry = await moveToTrash({ kind: "project", projectId: id, title: project.title, project: structuredClone(project) }, resolveDataPath(projectMediaDir(id)));
    db.projects = db.projects.filter((p) => p.id !== id);
    return entry;
  });
}

/** Devolve um projeto da lixeira, com os arquivos, exatamente como estava. */
export async function restoreProject(entryId: string): Promise<Project> {
  const project = await mutate(async (db) => {
    const entry = await getTrashEntry(entryId);
    if (!entry || entry.kind !== "project" || !entry.project) throw new StoreError("not_found", "Item da lixeira não encontrado.");
    if (db.projects.some((p) => p.id === entry.projectId)) throw new StoreError("invalid_transition", "Já existe um projeto com este identificador; nada foi alterado.");
    await restoreProjectFiles(entry);
    const now = new Date().toISOString();
    const restored: Project = structuredClone(entry.project);
    restored.updatedAt = now;
    restored.history = [...restored.history, { status: restored.status, at: now, note: "Restaurado da lixeira" }];
    // Um trabalho interrompido pela exclusão volta para a fila do worker.
    if (restored.job) restored.job = { ...restored.job, state: "queued", updatedAt: now };
    db.projects.push(restored);
    return structuredClone(restored);
  });
  await dropTrashEntry(entryId);
  return project;
}
