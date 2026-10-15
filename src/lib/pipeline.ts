import type { CaptionStyle, StageId } from "./types";

/**
 * Etapas do pipeline de processamento.
 *
 *   1. ingest     – upload do arquivo autorizado + leitura de metadados (ffprobe) ✅
 *   2. transcribe – faster-whisper local gera segmentos com timestamps     ✅ (worker/)
 *   3. select     – modelo local (Ollama) sugere e justifica os trechos   ✅ (worker/)
 *   4. review     – usuário aprova e ajusta início/fim na interface         ✅
 *   5. render     – FFmpeg corta, reenquadra para 9:16 e queima legendas   ✅ (worker/)
 *
 * Links do YouTube servem apenas para identificação e metadados (oEmbed /
 * Data API oficiais); o vídeo nunca é baixado da plataforma.
 */

export interface PipelineStage {
  id: StageId;
  label: string;
  description: string;
  engine: string;
  /** `false` enquanto a etapa não existir de verdade. */
  available: boolean;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "ingest",
    label: "Entrada do vídeo",
    description: "Upload do arquivo original que você tem direito de usar.",
    engine: "Upload local + ffprobe",
    available: true,
  },
  {
    id: "transcribe",
    label: "Transcrição",
    description: "Texto com timestamps por palavra, processado na sua máquina.",
    engine: "faster-whisper (worker local)",
    available: true,
  },
  {
    id: "select",
    label: "Seleção de cortes",
    description: "Encontra ganchos, picos de emoção e trechos autossuficientes.",
    engine: "Ollama local (worker)",
    available: true,
  },
  {
    id: "review",
    label: "Revisão",
    description: "Você aprova, rejeita e ajusta o início e o fim de cada corte.",
    engine: "Interface",
    available: true,
  },
  {
    id: "render",
    label: "Renderização 9:16",
    description: "Corte, reenquadramento vertical e legendas queimadas em MP4.",
    engine: "FFmpeg (worker local)",
    available: true,
  },
];

export interface TranscriptWord {
  word: string;
  startSec: number;
  endSec: number;
  probability?: number;
}

export interface TranscriptSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
  words?: TranscriptWord[];
}

/** Job enviado ao worker de renderização. */
export interface RenderJob {
  projectId: string;
  clipId: string;
  startSec: number;
  endSec: number;
  aspectRatio: "9:16";
  output: { container: "mp4"; videoCodec: "h264"; audioCodec: "aac"; height: 1920 };
  captions: { enabled: boolean; style: CaptionStyle };
}
