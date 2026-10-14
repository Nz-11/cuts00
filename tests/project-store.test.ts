import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { canTransition, PROJECT_STATUSES, TRANSITIONS } from "../src/lib/project-status.ts";
import * as store from "../src/server/project-store.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cca-store-"));
  process.env.CCA_DATA_DIR = dir;
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(path.join(dir, "projects.json"), { force: true });
});

describe("máquina de estados", () => {
  it("cobre todos os status", () => {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...PROJECT_STATUSES].sort());
  });
  it("segue o fluxo principal", () => {
    const flow = ["awaiting_source", "transcribing", "selecting", "review", "rendering", "completed"] as const;
    for (let i = 0; i < flow.length - 1; i++) assert.ok(canTransition(flow[i], flow[i + 1]), `${flow[i]} → ${flow[i + 1]}`);
  });
  it("bloqueia atalhos", () => {
    assert.equal(canTransition("awaiting_source", "review"), false);
    assert.equal(canTransition("transcribing", "completed"), false);
    assert.equal(canTransition("completed", "failed"), false);
  });
});

describe("project-store", () => {
  it("começa vazio quando não há arquivo", async () => {
    assert.deepEqual(await store.listProjects(), []);
  });

  it("cria, persiste em disco e encontra por videoId", async () => {
    const created = await store.createProject({ title: "Teste", youtube: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ", verified: true } });
    assert.equal(created.status, "awaiting_source");
    assert.equal(created.history.length, 1);

    const onDisk = JSON.parse(await readFile(path.join(dir, "projects.json"), "utf8"));
    assert.equal(onDisk.projects[0].id, created.id);
    assert.equal((await store.findProjectByVideoId("dQw4w9WgXcQ"))?.id, created.id);
    assert.equal(await store.findProjectByVideoId("outroVideo1"), undefined);
  });

  it("aplica transições válidas com histórico e job", async () => {
    const p = await store.createProject({ title: "Fluxo" });
    const t = await store.transitionProject(p.id, "transcribing", { note: "arquivo recebido", job: { message: "na fila" } });
    assert.equal(t.status, "transcribing");
    assert.equal(t.job?.state, "queued");
    assert.equal(t.history.at(-1)?.note, "arquivo recebido");

    const progressed = await store.updateJob(p.id, { state: "running", progress: 0.5 });
    assert.equal(progressed.job?.progress, 0.5);

    const failed = await store.transitionProject(p.id, "failed", { error: { stage: "transcribe", message: "sem memória" } });
    assert.equal(failed.job, undefined);
    assert.equal(failed.error?.stage, "transcribe");

    const back = await store.transitionProject(p.id, "awaiting_source");
    assert.equal(back.error, undefined);
    assert.equal(back.history.length, 4);
  });

  it("recusa transições inválidas sem alterar o projeto", async () => {
    const p = await store.createProject({ title: "Inválido" });
    await assert.rejects(store.transitionProject(p.id, "completed"), (err: unknown) => err instanceof store.StoreError && err.code === "invalid_transition");
    assert.equal((await store.getProject(p.id))?.status, "awaiting_source");
  });

  it("recusa progresso fora de processamento", async () => {
    const p = await store.createProject({ title: "Parado" });
    await assert.rejects(store.updateJob(p.id, { progress: 0.1 }), store.StoreError);
  });

  it("não perde escritas concorrentes", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.createProject({ title: `Projeto ${i}` })));
    assert.equal((await store.listProjects()).length, 25);
  });

  it("exclui o projeto e a pasta de mídia", async () => {
    const p = await store.createProject({ title: "Excluir" });
    const mediaDir = path.join(dir, store.projectMediaDir(p.id));
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, "source.mp4"), "x");
    await store.deleteProject(p.id);
    assert.equal(await store.getProject(p.id), undefined);
    await assert.rejects(stat(mediaDir));
  });

  it("informa arquivo corrompido em vez de sobrescrevê-lo", async () => {
    await writeFile(path.join(dir, "projects.json"), "{ quebrado");
    await assert.rejects(store.listProjects(), (err: unknown) => err instanceof store.StoreError && err.code === "corrupted");
    await assert.rejects(store.createProject({ title: "x" }), store.StoreError);
    assert.equal(await readFile(path.join(dir, "projects.json"), "utf8"), "{ quebrado");
  });

  it("impede caminhos fora da pasta de dados", () => {
    assert.throws(() => store.resolveDataPath("../fora.txt"));
  });
});
