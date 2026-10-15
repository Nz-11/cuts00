import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as store from "../src/server/project-store.ts";
import { confirmsTitle, getTrashEntry, listTrash, moveToTrash, purgeTrashEntry, restoreMediaFile, trashDir } from "../src/server/trash.ts";

let dir: string;

async function projectWithFiles(title: string) {
  const p = await store.createProject({ title });
  const media = path.join(dir, "media", p.id);
  await mkdir(path.join(media, "renders"), { recursive: true });
  await writeFile(path.join(media, "source-a.mp4"), "video autorizado");
  await writeFile(path.join(media, "transcript.json"), "{}");
  await writeFile(path.join(media, "renders", "c1-abc.mp4"), "corte");
  return { project: p, media };
}

async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe("lixeira", () => {
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cca-trash-"));
    process.env.CCA_DATA_DIR = dir;
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("excluir move o projeto e todos os arquivos para a lixeira, sem apagar nada", async () => {
    const { project, media } = await projectWithFiles("Podcast 1");
    const entry = await store.deleteProject(project.id);

    assert.equal(await store.getProject(project.id), undefined, "sai da lista");
    assert.equal(await exists(media), false, "a pasta de mídia saiu do lugar");
    const files = path.join(trashDir(), entry.id, "files");
    assert.equal(await readFile(path.join(files, "source-a.mp4"), "utf8"), "video autorizado");
    assert.equal(await readFile(path.join(files, "renders", "c1-abc.mp4"), "utf8"), "corte");

    const listed = (await listTrash()).find((e) => e.id === entry.id);
    assert.equal(listed?.title, "Podcast 1");
    assert.equal(listed?.sizeBytes, "video autorizado".length + 2 + "corte".length);
  });

  it("um segundo pedido de exclusão (clique duplo) não faz nada", async () => {
    const { project } = await projectWithFiles("Duplo");
    await store.deleteProject(project.id);
    const before = (await listTrash()).length;
    await assert.rejects(store.deleteProject(project.id), (err: unknown) => err instanceof store.StoreError && err.code === "not_found");
    assert.equal((await listTrash()).length, before, "nenhum item extra na lixeira");
  });

  it("restaurar devolve o projeto e os arquivos exatamente como estavam", async () => {
    const { project, media } = await projectWithFiles("Volta");
    await store.transitionProject(project.id, "transcribing", { job: { message: "fila" } });
    const entry = await store.deleteProject(project.id);

    const restored = await store.restoreProject(entry.id);
    assert.equal(restored.id, project.id);
    assert.equal(restored.status, "transcribing");
    assert.equal(restored.job?.state, "queued", "o trabalho volta para a fila do worker");
    assert.equal(restored.history.at(-1)?.note, "Restaurado da lixeira");
    assert.equal(await readFile(path.join(media, "source-a.mp4"), "utf8"), "video autorizado");
    assert.equal(await getTrashEntry(entry.id), undefined, "o item sai da lixeira");
    await assert.rejects(store.restoreProject(entry.id), store.StoreError, "restaurar de novo não duplica");
  });

  it("não restaura por cima de uma pasta existente", async () => {
    const { project, media } = await projectWithFiles("Conflito");
    const entry = await store.deleteProject(project.id);
    await mkdir(media, { recursive: true });
    await writeFile(path.join(media, "outro.txt"), "não mexer");
    await assert.rejects(store.restoreProject(entry.id), /Já existe uma pasta/);
    assert.equal(await readFile(path.join(media, "outro.txt"), "utf8"), "não mexer");
    assert.ok(await getTrashEntry(entry.id), "o item continua na lixeira");
    assert.equal(await store.getProject(project.id), undefined);
  });

  it("vídeo trocado vai para a lixeira e pode voltar", async () => {
    const { project, media } = await projectWithFiles("Troca");
    const file = path.join(media, "source-a.mp4");
    const mediaInfo = { originalName: "a.mp4", sizeBytes: 16, storedPath: `media/${project.id}/source-a.mp4`, uploadedAt: new Date().toISOString() };
    const entry = await moveToTrash({ kind: "media", projectId: project.id, title: "Troca — a.mp4", media: mediaInfo }, file);
    assert.equal(await exists(file), false);
    assert.equal(await exists(path.join(media, "transcript.json")), true, "a transcrição fica no projeto");
    await restoreMediaFile(entry);
    assert.equal(await readFile(file, "utf8"), "video autorizado");
  });

  it("excluir definitivamente só apaga o item escolhido", async () => {
    const a = await store.deleteProject((await projectWithFiles("Apagar")).project.id);
    const b = await store.deleteProject((await projectWithFiles("Manter")).project.id);
    await purgeTrashEntry(a.id);
    const names = await readdir(trashDir());
    assert.ok(!names.includes(a.id));
    assert.ok(names.includes(b.id));
    await assert.rejects(purgeTrashEntry(a.id), store.StoreError);
    await assert.rejects(purgeTrashEntry("../media"), store.StoreError, "identificador fora do padrão é recusado");
  });

  it("confirmação exige o nome exato", () => {
    assert.equal(confirmsTitle("Podcast 1", "Podcast 1"), true);
    assert.equal(confirmsTitle("  Podcast 1 ", "Podcast 1"), true);
    for (const typed of ["podcast 1", "Podcast", "", "   ", undefined, null, 1]) assert.equal(confirmsTitle(typed, "Podcast 1"), false, String(typed));
  });
});
