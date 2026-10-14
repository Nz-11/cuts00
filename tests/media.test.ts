import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { isFfprobeAvailable, probeMedia, ProbeUnavailableError } from "../src/server/media.ts";

const run = promisify(execFile);
let dir: string;
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(
  () => true,
  () => false,
);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cca-media-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Gera um vídeo sintético de 2 s com o FFmpeg local (sem baixar nada). */
async function makeVideo(name: string, withAudio: boolean) {
  const out = path.join(dir, name);
  const args = ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=2"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=2");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", ...(withAudio ? ["-c:a", "aac", "-shortest"] : []), "-y", out);
  await run("ffmpeg", args);
  return out;
}

describe("probeMedia (ffprobe)", { skip: hasFfmpeg ? false : "FFmpeg não instalado" }, () => {
  it("lê duração, resolução e faixas de um vídeo com áudio", async () => {
    const result = await probeMedia(await makeVideo("com-audio.mp4", true));
    assert.equal(result.hasVideo, true);
    assert.equal(result.hasAudio, true);
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.videoCodec, "h264");
    assert.ok(result.durationSec && Math.abs(result.durationSec - 2) < 0.2, `duração ${result.durationSec}`);
  });

  it("detecta vídeo sem faixa de áudio", async () => {
    const result = await probeMedia(await makeVideo("sem-audio.mp4", false));
    assert.equal(result.hasVideo, true);
    assert.equal(result.hasAudio, false);
  });

  it("rejeita arquivo que não é vídeo", async () => {
    const fake = path.join(dir, "falso.mp4");
    await writeFile(fake, "isto não é um vídeo");
    await assert.rejects(probeMedia(fake));
  });

  it("reporta ffprobe disponível", async () => {
    assert.equal(await isFfprobeAvailable(), true);
  });
});

describe("ffprobe ausente", () => {
  it("lança ProbeUnavailableError", async () => {
    await assert.rejects(probeMedia("x.mp4", "binario-que-nao-existe-cca"), ProbeUnavailableError);
    assert.equal(await isFfprobeAvailable("binario-que-nao-existe-cca"), false);
  });
});
