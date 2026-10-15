/**
 * Modelos de domínio. São compartilhados entre a interface, o armazenamento
 * local (.data/projects.json) e o futuro worker Python (Whisper + FFmpeg).
 */

/**
 * Ciclo de vida de um projeto real. Transições permitidas em `project-status.ts`.
 * - `awaiting_source`: aguardando o arquivo de vídeo autorizado.
 * - `transcribing`: arquivo recebido; transcrição (Whisper) na fila ou em andamento.
 * - `selecting`: IA selecionando trechos a partir da transcrição.
 * - `review`: cortes sugeridos aguardando revisão do usuário.
 * - `rendering`: FFmpeg gerando os MP4 verticais.
 * - `completed`: cortes renderizados.
 * - `failed`: alguma etapa falhou (ver `error`).
 */
export type ProjectStatus = "awaiting_source" | "transcribing" | "selecting" | "review" | "rendering" | "completed" | "failed";

export type StageId = "ingest" | "transcribe" | "select" | "review" | "render";

/** Referência ao vídeo no YouTube. Usada só para identificação e metadados. */
export interface YouTubeRef {
  url: string;
  videoId: string;
  /** Título e canal vindos do oEmbed oficial do YouTube, quando disponível. */
  title?: string;
  channel?: string;
  /** `true` se o oEmbed confirmou que o vídeo existe e é acessível. */
  verified: boolean;
}

/** Arquivo de vídeo autorizado, enviado pelo usuário e guardado localmente. */
export interface MediaFile {
  originalName: string;
  sizeBytes: number;
  /** Caminho relativo à pasta de dados (ex.: `media/p_x/source.mp4`). */
  storedPath: string;
  uploadedAt: string;
  /** Metadados lidos pelo ffprobe. */
  durationSec?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  hasAudio?: boolean;
}

export interface JobInfo {
  state: "queued" | "running";
  /** 0–1 */
  progress: number;
  message?: string;
  updatedAt: string;
}

export interface StatusEvent {
  status: ProjectStatus;
  at: string;
  note?: string;
}

export interface Project {
  id: string;
  title: string;
  youtube?: YouTubeRef;
  media?: MediaFile;
  status: ProjectStatus;
  job?: JobInfo;
  error?: { stage: StageId; message: string };
  createdAt: string;
  updatedAt: string;
  rightsConfirmedAt: string;
  clips: Clip[];
  history: StatusEvent[];
}

export type ClipDecision = "pending" | "approved" | "rejected";

export interface Clip {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  /**
   * 0–100. Com `analysis`, é calculada pelos critérios (ver `clip-analysis.ts`);
   * em cortes antigos, é a nota única dada pelo modelo.
   */
  score: number;
  /** Justificativa gerada pela IA para a escolha do trecho. */
  reason: string;
  hook: string;
  transcript: string;
  tags: string[];
  decision: ClipDecision;
  /** Avaliação por critério (ausente em cortes gerados antes da v0.6). */
  analysis?: ClipAnalysis;
  /** Última renderização pedida para este corte (ausente = nunca renderizado). */
  render?: ClipRender;
}

export type ClipCriterion = "hook" | "clarity" | "value" | "standalone" | "pacing";
export type ClipCriteria = Record<ClipCriterion, number>;
/** Como o corte começa ou termina: fim de frase, pausa longa ou meio de frase. */
export type ClipBoundary = "sentence" | "pause" | "mid";

export interface ClipAnalysis {
  version: 1;
  /** Notas de 1 a 5 dadas pelo modelo local (limitadas pelo worker em casos objetivos). */
  criteria: ClipCriteria;
  /** 0–100: semelhança com um corte mais bem avaliado (tempo ou vocabulário). */
  redundancyPct: number;
  boundaries: { start: ClipBoundary; end: ClipBoundary };
  /** Ajustes automáticos feitos nas bordas e no gancho. */
  adjustments: string[];
  /** Pontos para conferir antes de publicar. */
  warnings: string[];
}

/**
 * Enquadramento vertical: recorte fixo no rosto principal (volta ao centro se não detectar com
 * segurança), recorte central (preenche a tela) ou imagem inteira sobre fundo desfocado.
 */
export type RenderFraming = "face" | "crop" | "blur";
/** Estilo das legendas queimadas no vídeo. */
export type RenderCaptions = "classic" | "keywords" | "highlight" | "none";
export type ClipRenderState = "queued" | "running" | "done" | "failed";

export interface ClipRender {
  state: ClipRenderState;
  /** 0–1 */
  progress: number;
  framing: RenderFraming;
  captions: RenderCaptions;
  /** Intervalo usado na renderização (cópia feita no pedido). */
  startSec: number;
  endSec: number;
  requestedAt: string;
  updatedAt: string;
  /** Arquivo gerado, relativo à pasta de mídia do projeto (ex.: "renders/c1-1a2b3c4d.mp4"). */
  file?: string;
  sizeBytes?: number;
  durationSec?: number;
  /** Como o enquadramento "face" foi decidido (rosto detectado, posição ou motivo do recorte central). */
  framingNote?: string;
  /** Resolução da fonte e ampliação aplicada (ex.: "Fonte 640×360: … ampliado 3,6× para 720×1280"). */
  qualityNote?: string;
  error?: string;
}

export type CaptionPosition = "top" | "middle" | "bottom";

export interface CaptionStyle {
  fontFamily: "Sora" | "Geist" | "Impact";
  fontSize: number;
  textColor: string;
  highlightColor: string;
  position: CaptionPosition;
  uppercase: boolean;
}

export interface AppSettings {
  displayName: string;
  showDemoData: boolean;
  language: "pt" | "en" | "es" | "auto";
  whisperModel: "tiny" | "base" | "small" | "medium";
  clipMinSec: number;
  clipMaxSec: number;
  caption: CaptionStyle;
}
