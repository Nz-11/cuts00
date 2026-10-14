import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobInfo, Project, ProjectStatus, StageId, YouTubeRef } from "../lib/types";
import { canTransition, PROCESSING_STATUSES } from "../lib/project-status.ts";

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

const dbFile = () => path.join(dataDir(), "projects.json");

/** Pasta dos arquivos de um projeto, relativa à pasta de dados. */
export function projectMediaDir(id: string) {
  return path.join("media", id);
}

export function resolveDataPath(relative: string) {
  const full = path.resolve(dataDir(), relative);
  if (!full.startsWith(dataDir() + path.sep)) throw new Error("Caminho fora da pasta de dados.");
  return full;
}

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

export async function deleteProject(id: string): Promise<void> {
  await mutate((db) => {
    find(db, id);
    db.projects = db.projects.filter((p) => p.id !== id);
  });
  await rm(resolveDataPath(projectMediaDir(id)), { recursive: true, force: true });
}
