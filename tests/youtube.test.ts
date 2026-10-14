import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseYouTubeVideoId } from "../src/lib/youtube.ts";
import { lookupYouTubeVideo } from "../src/server/youtube-oembed.ts";

describe("parseYouTubeVideoId", () => {
  const id = "dQw4w9WgXcQ";
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `  https://www.youtube.com/watch?v=${id}  `,
  ]) {
    it(`aceita ${url.trim()}`, () => assert.equal(parseYouTubeVideoId(url), id));
  }

  for (const url of ["", "não é link", "https://vimeo.com/123", "https://www.youtube.com/watch?v=curto", "https://www.youtube.com/channel/UC123", "https://evil.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)"]) {
    it(`rejeita "${url}"`, () => assert.equal(parseYouTubeVideoId(url), null));
  }
});

describe("lookupYouTubeVideo (oEmbed)", () => {
  const fakeFetch = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("retorna título e canal quando o vídeo existe", async () => {
    const result = await lookupYouTubeVideo("dQw4w9WgXcQ", fakeFetch(200, { title: "Meu vídeo", author_name: "Meu canal" }));
    assert.deepEqual(result, { kind: "found", title: "Meu vídeo", channel: "Meu canal" });
  });
  it("identifica vídeo privado/restrito (401)", async () => {
    assert.equal((await lookupYouTubeVideo("x", fakeFetch(401))).kind, "restricted");
  });
  it("identifica vídeo inexistente (404)", async () => {
    assert.equal((await lookupYouTubeVideo("x", fakeFetch(404))).kind, "not_found");
  });
  it("trata falha de rede como indisponível, sem lançar", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.equal((await lookupYouTubeVideo("x", failing)).kind, "unavailable");
  });
});
