import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { clipRangeProblem, downloadFileName, isRenderStale, RENDER_FILE_RE, renderQuality, validateRenderRequest } from "../src/lib/render.ts";
import type { Clip, Project } from "../src/lib/types.ts";
import * as store from "../src/server/project-store.ts";

function clip(id: string, startSec: number, endSec: number, decision: Clip["decision"] = "approved"): Clip {
  return { id, title: `Corte ${id}`, startSec, endSec, score: 80, reason: "r", hook: "h", transcript: "t", tags: [], decision };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p_test",
    title: "Teste",
    status: "review",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    rightsConfirmedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    media: { originalName: "a.mp4", sizeBytes: 1, storedPath: "media/p_test/source-a.mp4", uploadedAt: "2026-01-01T00:00:00.000Z", durationSec: 120 },
    clips: [clip("c1", 10, 40), clip("c2", 50, 80), clip("c3", 90, 110, "pending"), clip("c4", 0, 20, "rejected")],
    ...overrides,
  };
}

describe("validateRenderRequest", () => {
  it("por padrão, renderiza todos os aprovados", () => {
    const r = validateRenderRequest(project(), { framing: "crop", captions: "classic" });
    assert.deepEqual(r, { ok: true, framing: "crop", captions: "classic", clipIds: ["c1", "c2"] });
  });

  it("aceita os três enquadramentos, inclusive rosto", () => {
    for (const framing of ["face", "crop", "blur"]) {
      assert.equal(validateRenderRequest(project(), { framing, captions: "none" }).ok, true, framing);
    }
  });

  it("aceita todos os estilos de legenda, inclusive palavras-chave", () => {
    for (const captions of ["classic", "keywords", "highlight", "none"]) {
      assert.equal(validateRenderRequest(project(), { framing: "crop", captions }).ok, true, captions);
    }
  });

  it("só aceita cortes aprovados", () => {
    const r = validateRenderRequest(project(), { framing: "blur", captions: "none", clipIds: ["c1", "c3"] });
    assert.equal(r.ok, false);
    const none = validateRenderRequest(project({ clips: [clip("c1", 0, 10, "pending")] }), { framing: "crop", captions: "none" });
    assert.match(none.ok ? "" : none.error, /Aprove pelo menos um corte/);
  });

  it("recusa opções fora da lista e listas malformadas", () => {
    for (const input of [
      { framing: "zoom", captions: "none" },
      { framing: "crop", captions: "neon" },
      { framing: "crop;rm -rf", captions: "none" },
      { framing: "crop", captions: "none", clipIds: "c1" },
      { framing: "crop", captions: "none", clipIds: [1] },
    ]) {
      assert.equal(validateRenderRequest(project(), input).ok, false, JSON.stringify(input));
    }
  });

  it("recusa timestamps fora do vídeo", () => {
    const r = validateRenderRequest(project({ clips: [clip("c1", 100, 130)] }), { framing: "crop", captions: "none" });
    assert.match(r.ok ? "" : r.error, /depois do fim do vídeo/);
  });

  it("só aceita pedidos na revisão, após concluir ou após falha de renderização", () => {
    assert.equal(validateRenderRequest(project({ status: "selecting" }), { framing: "crop", captions: "none" }).ok, false);
    assert.equal(validateRenderRequest(project({ status: "rendering" }), { framing: "crop", captions: "none" }).ok, false);
    assert.equal(validateRenderRequest(project({ status: "completed" }), { framing: "crop", captions: "none" }).ok, true);
    assert.equal(validateRenderRequest(project({ status: "failed", error: { stage: "select", message: "x" } }), { framing: "crop", captions: "none" }).ok, false);
    assert.equal(validateRenderRequest(project({ status: "failed", error: { stage: "render", message: "x" } }), { framing: "crop", captions: "none" }).ok, true);
  });
});

describe("regras auxiliares", () => {
  it("clipRangeProblem", () => {
    assert.equal(clipRangeProblem({ startSec: 0, endSec: 10 }, 10), null);
    assert.match(clipRangeProblem({ startSec: -1, endSec: 10 }, 60) ?? "", /antes do início/);
    assert.match(clipRangeProblem({ startSec: 5, endSec: 5.5 }, 60) ?? "", /menos de 1 segundo/);
    assert.match(clipRangeProblem({ startSec: 0, endSec: 700 }, 1000) ?? "", /mais de 10 minutos/);
    assert.match(clipRangeProblem({ startSec: 0, endSec: Number.NaN }, 60) ?? "", /inválidos/);
  });

  it("detecta renderização desatualizada", () => {
    const c = clip("c1", 10, 40);
    c.render = { state: "done", progress: 1, framing: "crop", captions: "none", startSec: 10, endSec: 40, requestedAt: "", updatedAt: "" };
    assert.equal(isRenderStale(c), false);
    assert.equal(isRenderStale({ ...c, endSec: 42 }), true);
  });

  it("caminho de arquivo renderizado", () => {
    assert.ok(RENDER_FILE_RE.test("renders/c1-0a1b2c3d4e.mp4"));
    for (const bad of ["renders/../source.mp4", "../renders/c1.mp4", "renders/c1.mov", "renders/sub/c1.mp4", "source-a.mp4", "renders\\c1.mp4"]) {
      assert.equal(RENDER_FILE_RE.test(bad), false, bad);
    }
  });

  it("nome de download seguro", () => {
    assert.equal(downloadFileName("Podcast: Episódio #42!", { id: "c1", title: "A lição do golpe de R$ 30 mil" }), "podcast-episodio-42-c1-a-licao-do-golpe-de-r-30-mil.mp4");
    assert.equal(downloadFileName("???", { id: "c2", title: "" }), "c2.mp4");
  });
});

describe("renderQuality (mesma regra do worker)", () => {
  it("fontes de baixa resolução saem menores para não ampliar demais", () => {
    // Os mesmos exemplos estão em worker/tests/test_framing.py (OutputPlanTests).
    const cases: [number, number, "crop" | "face" | "blur", number, number, number][] = [
      [640, 360, "crop", 720, 1280, 3.56],
      [640, 360, "face", 720, 1280, 3.56],
      [640, 360, "blur", 1080, 1920, 1.69],
      [854, 480, "crop", 720, 1280, 2.67],
      [1280, 720, "crop", 1080, 1920, 2.67],
      [1920, 1080, "crop", 1080, 1920, 1.78],
      [1920, 1080, "blur", 1080, 1920, 0.56],
      [1080, 1920, "crop", 1080, 1920, 1],
      [720, 1280, "blur", 1080, 1920, 1.5],
    ];
    for (const [w, h, framing, ow, oh, up] of cases) {
      const q = renderQuality(w, h, framing);
      assert.deepEqual([q?.width, q?.height], [ow, oh], `${w}x${h} ${framing}`);
      assert.ok(Math.abs((q?.upscale ?? 0) - up) <= 0.01, `${w}x${h} ${framing}: ${q?.upscale}`);
    }
    assert.equal(renderQuality(undefined, 360, "crop"), null);
  });
});

describe("updateClipRender (store)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cca-render-store-"));
    process.env.CCA_DATA_DIR = dir;
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("só atualiza durante a renderização e limpa o erro ao avançar", async () => {
    const p = await store.createProject({ title: "Render" });
    await store.transitionProject(p.id, "transcribing");
    await store.transitionProject(p.id, "selecting");
    await store.transitionProject(p.id, "review", { apply: (x) => void (x.clips = [clip("c1", 0, 10)]) });
    await assert.rejects(store.updateClipRender(p.id, "c1", { state: "running" }), store.StoreError);

    await store.transitionProject(p.id, "rendering", {
      apply: (x) => {
        x.clips[0].render = { state: "queued", progress: 0, framing: "crop", captions: "none", startSec: 0, endSec: 10, requestedAt: "", updatedAt: "" };
      },
    });
    const failed = await store.updateClipRender(p.id, "c1", { state: "failed", error: "falhou" });
    assert.equal(failed.clips[0].render?.error, "falhou");
    const running = await store.updateClipRender(p.id, "c1", { state: "running", progress: 0.5 });
    assert.equal(running.clips[0].render?.error, undefined);
    assert.equal(running.clips[0].render?.framing, "crop", "opções do pedido são preservadas");
    await assert.rejects(store.updateClipRender(p.id, "c9", { state: "running" }), store.StoreError);
  });
});
