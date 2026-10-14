import type { Project } from "./types";

/**
 * EXEMPLOS FICTÍCIOS, isolados dos projetos reais: vivem apenas aqui, são
 * exibidos em /demo/... e nunca são gravados em `.data/`. Nada disto foi
 * processado de verdade. Podem ser ocultados em Configurações.
 */

export const DEMO_PROJECTS: Project[] = [
  {
    id: "podcast-ep42",
    title: "Podcast #42 — Como saí do zero aos 100 mil inscritos",
    status: "review",
    createdAt: "2026-10-12T14:20:00.000Z",
    updatedAt: "2026-10-12T15:02:00.000Z",
    rightsConfirmedAt: "2026-10-12T14:20:00.000Z",
    media: { originalName: "podcast-ep42-master.mp4", sizeBytes: 2_840_000_000, storedPath: "", uploadedAt: "2026-10-12T14:21:00.000Z", durationSec: 5420, width: 1920, height: 1080, hasAudio: true },
    history: [
      { status: "awaiting_source", at: "2026-10-12T14:20:00.000Z", note: "Projeto criado" },
      { status: "transcribing", at: "2026-10-12T14:21:00.000Z", note: "Arquivo recebido" },
      { status: "selecting", at: "2026-10-12T14:48:00.000Z", note: "Transcrição concluída" },
      { status: "review", at: "2026-10-12T15:02:00.000Z", note: "4 cortes sugeridos" },
    ],
    clips: [
      {
        id: "c1",
        title: "O erro que travou o canal por 2 anos",
        startSec: 812,
        endSec: 869,
        score: 94,
        hook: "Eu passei dois anos fazendo a coisa certa do jeito errado.",
        reason: "Abre com uma confissão forte nos 3 primeiros segundos, tem conflito claro e uma virada no final. Funciona sem contexto do episódio.",
        transcript:
          "Eu passei dois anos fazendo a coisa certa do jeito errado. Postava todo dia, mas nenhum vídeo tinha um motivo para alguém clicar. Quando eu parei e perguntei 'por que alguém assistiria isso?', tudo mudou.",
        tags: ["gancho forte", "história pessoal"],
        decision: "approved",
      },
      {
        id: "c2",
        title: "A regra dos 30 segundos",
        startSec: 1534,
        endSec: 1581,
        score: 88,
        hook: "Se você não prende a pessoa em 30 segundos, já perdeu.",
        reason: "Dica prática e acionável em formato de regra, ritmo de fala acelerado e frase de efeito citável — alto potencial de compartilhamento.",
        transcript:
          "Se você não prende a pessoa em 30 segundos, já perdeu. Não é sobre ser chamativo, é sobre deixar claro qual problema você vai resolver. Promessa no começo, entrega no meio, surpresa no fim.",
        tags: ["dica prática", "citável"],
        decision: "pending",
      },
      {
        id: "c3",
        title: "Quanto rende de verdade um canal médio",
        startSec: 2702,
        endSec: 2771,
        score: 81,
        hook: "Vou abrir os números que ninguém mostra.",
        reason: "Tema de curiosidade (dinheiro) com números concretos. Ponto de atenção: menciona 'como falei antes' aos 00:41 — considere cortar 4s antes.",
        transcript:
          "Vou abrir os números que ninguém mostra. Com cem mil inscritos, num mês bom, dá pra pagar as contas. Num mês ruim, não. Como falei antes, a renda vem de três lugares diferentes...",
        tags: ["curiosidade", "números"],
        decision: "pending",
      },
      {
        id: "c4",
        title: "Equipamento não importa (até importar)",
        startSec: 3990,
        endSec: 4036,
        score: 72,
        hook: "Gravei os primeiros 200 vídeos com o celular.",
        reason: "Contraponto a uma crença comum, bom para debate nos comentários. Pontuação menor porque o final depende de pergunta do entrevistador.",
        transcript:
          "Gravei os primeiros 200 vídeos com o celular. Equipamento não importa até o dia em que importa: quando o conteúdo já é bom e a qualidade vira o gargalo.",
        tags: ["polêmico", "bastidores"],
        decision: "rejected",
      },
    ],
  },
  {
    id: "live-review",
    title: "Live de sexta — Review de canais da comunidade",
    status: "selecting",
    createdAt: "2026-10-11T22:05:00.000Z",
    updatedAt: "2026-10-11T23:40:00.000Z",
    rightsConfirmedAt: "2026-10-11T22:05:00.000Z",
    media: { originalName: "live-sexta.mkv", sizeBytes: 4_100_000_000, storedPath: "", uploadedAt: "2026-10-11T22:06:00.000Z", durationSec: 7810, hasAudio: true },
    job: { state: "running", progress: 0.62, message: "Avaliando 214 trechos candidatos", updatedAt: "2026-10-11T23:40:00.000Z" },
    history: [
      { status: "awaiting_source", at: "2026-10-11T22:05:00.000Z" },
      { status: "transcribing", at: "2026-10-11T22:06:00.000Z" },
      { status: "selecting", at: "2026-10-11T23:31:00.000Z" },
    ],
    clips: [],
  },
  {
    id: "tutorial-shorts",
    title: "Tutorial: edição rápida para Shorts",
    status: "transcribing",
    createdAt: "2026-10-10T09:40:00.000Z",
    updatedAt: "2026-10-10T09:52:00.000Z",
    rightsConfirmedAt: "2026-10-10T09:40:00.000Z",
    media: { originalName: "tutorial-shorts-v2.mov", sizeBytes: 960_000_000, storedPath: "", uploadedAt: "2026-10-10T09:41:00.000Z", durationSec: 1340, hasAudio: true },
    job: { state: "running", progress: 0.38, message: "Transcrevendo 08:29 de 22:20", updatedAt: "2026-10-10T09:52:00.000Z" },
    history: [
      { status: "awaiting_source", at: "2026-10-10T09:40:00.000Z" },
      { status: "transcribing", at: "2026-10-10T09:41:00.000Z" },
    ],
    clips: [],
  },
  {
    id: "vlog-falha",
    title: "Vlog — bastidores do estúdio novo",
    status: "failed",
    createdAt: "2026-10-08T17:12:00.000Z",
    updatedAt: "2026-10-08T17:20:00.000Z",
    rightsConfirmedAt: "2026-10-08T17:12:00.000Z",
    media: { originalName: "vlog-estudio.mp4", sizeBytes: 1_250_000_000, storedPath: "", uploadedAt: "2026-10-08T17:13:00.000Z", durationSec: 980, hasAudio: true },
    error: { stage: "transcribe", message: "Memória insuficiente para o modelo Whisper 'medium' (exemplo demonstrativo)." },
    history: [
      { status: "awaiting_source", at: "2026-10-08T17:12:00.000Z" },
      { status: "transcribing", at: "2026-10-08T17:13:00.000Z" },
      { status: "failed", at: "2026-10-08T17:20:00.000Z" },
    ],
    clips: [],
  },
];

export function getDemoProject(id: string) {
  return DEMO_PROJECTS.find((p) => p.id === id);
}
