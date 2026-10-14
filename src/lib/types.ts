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
  /** 0–100: confiança da IA de que o trecho funciona como corte isolado. */
  score: number;
  /** Justificativa gerada pela IA para a escolha do trecho. */
  reason: string;
  hook: string;
  transcript: string;
  tags: string[];
  decision: ClipDecision;
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
