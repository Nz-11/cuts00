# Arquitetura — Cezario's Clips AI

## Estado atual (v0.3 — transcrição local)

- **Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + Lucide.** Nenhuma dependência paga.
- **Projetos reais** ficam em `.data/projects.json` (fora do Git), gravados pelo servidor com escrita atômica e fila de exclusividade (`src/server/project-store.ts`). Não há nuvem.
- **Vídeos enviados** vão para `.data/media/<id>/` e são validados com o **ffprobe** local (vídeo, áudio, duração, resolução).
- **YouTube:** o link é validado (cliente e servidor), duplicatas são bloqueadas e título/canal são confirmados pelo **oEmbed oficial** (gratuito, sem chave). O vídeo **nunca** é baixado do YouTube.
- **Exemplos fictícios** vivem só em `src/lib/demo-data.ts`, aparecem em `/demo/...` e numa seção própria do dashboard. Nunca são gravados nem entram nas estatísticas.
- **Transcrição:** o worker Python (`worker/`) consome `/api/worker/*`, extrai o áudio com o FFmpeg e transcreve com o **faster-whisper** (CPU, int8, português). O resultado vai para `.data/media/<id>/transcript.json`, com timestamps por trecho e por palavra, e o projeto passa para `selecting`. Detalhes em `worker/README.md`.
- **Preferências** (nome, legenda) ficam no `localStorage` do navegador. O worker usa variáveis do `.env.local` (`CCA_WHISPER_*`).

## Estados do projeto

```
awaiting_source ──upload──▶ transcribing ──▶ selecting ──▶ review ──▶ rendering ──▶ completed
       ▲                        │ (na fila: trocar arquivo)   ▲  │                    │
       └────────────────────────┘                             │  └──── novas sugestões │
                       failed ◀── qualquer etapa de processamento ─────────────────────┘
```

Regras em `src/lib/project-status.ts`, aplicadas no servidor (store + API do worker).
Cada mudança fica registrada em `history`.

```
src/
  app/
    (app)/page.tsx              dashboard (dados reais via servidor + seção de exemplos)
    (app)/projects/new          cadastro (YouTube ou arquivo)
    (app)/projects/[id]         status, upload, histórico
    (app)/projects/[id]/review  revisão com ajustes salvos no servidor
    (app)/demo/[id]             exemplos fictícios (somente leitura)
    api/projects/[id]/media     PUT: upload em streaming + ffprobe
    api/worker/jobs             GET: fila para o worker (token)
    api/worker/projects/[id]    POST: progresso/transições do worker (token)
  server/                       código só do servidor: store, actions, ffprobe, oEmbed, auth
  lib/                          tipos, máquina de estados, pipeline, utilitários
tests/                          node --test (store, estados, YouTube, ffprobe)
worker/                         worker Python de transcrição (faster-whisper) + contrato da API
```

## Roadmap

| Etapa | Implementação | Custo | Status |
|---|---|---|---|
| Entrada | Upload do arquivo próprio + ffprobe | R$ 0 | ✅ |
| Transcrição | `faster-whisper` local (worker) | R$ 0 | ✅ |
| Seleção por IA | Modelo local (ex.: Ollama) ou API paga **somente com autorização** | R$ 0 local | próxima |
| Revisão | Interface com ajustes persistidos | — | ✅ (sem cortes reais até a seleção existir) |
| Renderização | FFmpeg: corte, crop 9:16, legendas ASS, MP4 | R$ 0 | — |
| Contas / SaaS | Supabase Auth + Postgres com RLS, trocando o `project-store` | plano gratuito | — |

## Regras

- Nunca baixar vídeos do YouTube nem contornar proteções.
- Chaves secretas só em variáveis de ambiente do servidor.
- O app roda sem Supabase. **Não exponha este servidor na internet**: não há autenticação de usuários (protótipo local).
