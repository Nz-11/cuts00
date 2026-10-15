import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRange, videoContentType } from "../src/server/http-range.ts";
import { isOllamaRunning } from "../src/server/ollama-status.ts";

describe("parseRange", () => {
  it("sem cabeçalho entrega o arquivo inteiro", () => {
    assert.equal(parseRange(null, 1000), null);
  });
  it("interpreta intervalos abertos, fechados e sufixos", () => {
    assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 });
    assert.deepEqual(parseRange("bytes=100-199", 1000), { start: 100, end: 199 });
    assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
    assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "fim além do arquivo é limitado");
    assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
  });
  it("recusa intervalos impossíveis ou malformados", () => {
    for (const h of ["bytes=1000-", "bytes=500-100", "bytes=-0", "bytes=-", "bytes=0-1,5-9", "items=0-1", "bytes=a-b"]) {
      assert.equal(parseRange(h, 1000), "invalid", h);
    }
    assert.equal(parseRange("bytes=0-", 0), "invalid");
  });
});

describe("videoContentType", () => {
  it("mapeia extensões de vídeo", () => {
    assert.equal(videoContentType("source-1.mp4"), "video/mp4");
    assert.equal(videoContentType("a.WEBM"), "video/webm");
    assert.equal(videoContentType("x.exe"), "application/octet-stream");
  });
});

describe("isOllamaRunning", () => {
  it("só consulta endereços deste computador", async () => {
    const calls: string[] = [];
    const fake = (async (url: URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const previous = process.env.CCA_OLLAMA_URL;
    try {
      process.env.CCA_OLLAMA_URL = "http://exemplo.com:11434";
      assert.equal(await isOllamaRunning(fake), false);
      assert.equal(calls.length, 0);
      process.env.CCA_OLLAMA_URL = "http://127.0.0.1:11434";
      assert.equal(await isOllamaRunning(fake), true);
      assert.equal(calls[0], "http://127.0.0.1:11434/api/version");
    } finally {
      if (previous === undefined) delete process.env.CCA_OLLAMA_URL;
      else process.env.CCA_OLLAMA_URL = previous;
    }
  });
  it("retorna false quando não há resposta", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.equal(await isOllamaRunning(failing), false);
  });
});
