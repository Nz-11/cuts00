# Arquitetura — Cezario's Clips AI

## Estado atual (v0.6 — qualidade dos cortes)

- **Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + Lucide.** Nenhuma dependência paga.
- **Projetos reais** ficam em `.data/projects.json` (fora do Git), gravados pelo servidor com escrita atômica e fila de exclusividade (`src/server/project-store.ts`). Não há nuvem.
- **Exclusão protegida e Lixeira** (`src/server/trash.ts`, página `/trash`):
  - "Excluir" abre uma confirmação separada: é preciso digitar o nome do projeto, e o botão só funciona 0,8 s depois de abrir (absorve clique duplo). O servidor confere o nome de novo, então chamadas repetidas ou acidentais não excluem nada.
  - O projeto e a pasta `media/<id>` são **movidos** (rename, sem cópia) para `.data/trash/<id>-<data>/`, com uma ficha `entry.json`. "Trocar arquivo" faz o mesmo com o vídeo antigo.
  - Na Lixeira: "Restaurar" devolve tudo como estava (trabalho interrompido volta para a fila); "Excluir definitivamente" pede o nome de novo e é o único caminho que apaga arquivos.
  - Antes desta versão, excluir apagava na hora (sem Lixeira do Windows): projetos excluídos antes dela não podem ser recuperados.
- **Vídeos enviados** vão para `.data/media/<id>/` e são validados com o **ffprobe** local (vídeo, áudio, duração, resolução).
- **YouTube:** o link é validado (cliente e servidor), duplicatas são bloqueadas e título/canal são confirmados pelo **oEmbed oficial** (gratuito, sem chave). O vídeo **nunca** é baixado do YouTube.
- **Exemplos fictícios** vivem só em `src/lib/demo-data.ts`, aparecem em `/demo/...` e numa seção própria do dashboard. Nunca são gravados nem entram nas estatísticas.
- **Transcrição:** o worker Python (`worker/`) consome `/api/worker/*`, extrai o áudio com o FFmpeg e transcreve com o **faster-whisper** (CPU, int8, português). O resultado vai para `.data/media/<id>/transcript.json`, com timestamps por trecho e por palavra, e o projeto passa para `selecting`. Detalhes em `worker/README.md`.
- **Seleção de cortes:** o mesmo worker processa os projetos em `selecting`, reaproveitando o `transcript.json` (nunca transcreve de novo).
  - As palavras do Whisper são reagrupadas em **frases** (`worker/cca_worker/units.py`); o modelo escolhe números de frases, então os cortes começam e terminam em frase completa.
  - O **Ollama local** (`qwen2.5:7b`; só endereços locais são aceitos) recebe as frases em partes, com contexto vizinho sem número, e devolve as frases de início e fim, o gancho e notas de 1 a 5 por critério.
  - Os segundos vêm dos tempos das palavras, com uma folga que nunca invade a fala vizinha. As bordas são ajustadas por regras (vinhetas, "porque…" sem contexto, frase cortada) e o gancho precisa ser uma fala real.
  - A **nota final** é calculada pelo código (`worker/cca_worker/scoring.py`, refeita em `src/lib/clip-analysis.ts`), com pesos documentados, redutores objetivos e penalidade de redundância; quase-duplicatas são descartadas.
  - O progresso fica em `.data/media/<id>/selection.json`, o que permite retomar sem duplicar. O resultado vai para `review` com os cortes e a avaliação (`analysis`).
- **Revisão:** cortes recomendados (até 3, nota ≥ 60), motivo, pontos fortes, nota por critério com a conta, ajustes automáticos e alertas; player do vídeo original via `GET /api/projects/:id/media` (somente leitura, com Range, restrito ao arquivo do projeto), com aprovar, rejeitar, ajustar, "Gerar novas sugestões" (`review → selecting`) e "Tentar selecionar de novo" (`failed → selecting`).
- **Renderização:**
  - "Renderizar aprovados" (`review/completed → rendering`) grava em cada corte aprovado uma ficha `render`: estado, progresso, opções e cópia dos timestamps.
  - O worker gera MP4 9:16 (H.264 + AAC) com o FFmpeg, em 1080×1920 ou, se a fonte for de baixa resolução e o recorte exigiria ampliar mais de 3×, em 720×1280 (regra igual em `output_plan` e `renderQuality`). Enquadramentos `face`/`crop`/`blur` (`face`: janela fixa no rosto detectado pelo YuNet local; rosto pequeno → fundo desfocado; detecção falhou → centro) e nas legendas `classic`/`keywords`/`highlight`/`none`, a partir do `transcript.json`, com volume uniforme (ganho único limitado pelo pico).
  - O estado de cada corte é informado pela ação `clip` da API do worker.
  - Os arquivos ficam em `.data/media/<id>/renders/<corte>-<hash>.mp4`, sem sobrescrever nada.
  - Pré-visualização e download por `GET /api/projects/:id/renders/:clipId`.
  - Falha parcial: `completed`, com "Tentar novamente" para os cortes que falharam. Falha total: `failed` na etapa `render`.
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
    api/projects/[id]/media     PUT: upload em streaming + ffprobe · GET: vídeo para o player (Range)
    api/projects/[id]/renders/[clipId]  GET: MP4 renderizado (prévia/download, Range)
    api/worker/jobs             GET: fila para o worker (token)
    api/worker/projects/[id]    POST: progresso/transições do worker (token)
  server/                       código só do servidor: store, actions, ffprobe, oEmbed, auth
  lib/                          tipos, máquina de estados, pipeline, utilitários
tests/                          node --test (store, estados, YouTube, ffprobe)
worker/                         worker Python: transcrição (faster-whisper) + seleção (Ollama) + renderização (FFmpeg) + contrato da API
```

## Roadmap

| Etapa | Implementação | Custo | Status |
|---|---|---|---|
| Entrada | Upload do arquivo próprio + ffprobe | R$ 0 | ✅ |
| Transcrição | `faster-whisper` local (worker) | R$ 0 | ✅ |
| Seleção por IA | Ollama local (`qwen2.5:7b`); API paga **somente com autorização** | R$ 0 | ✅ |
| Revisão | Player do vídeo real + ajustes persistidos | — | ✅ |
| Renderização | FFmpeg: corte, 9:16 (recorte/fundo desfocado), legendas ASS, MP4 | R$ 0 | ✅ |
| Contas / SaaS | Supabase Auth + Postgres com RLS, trocando o `project-store` | plano gratuito | — |

## Regras

- Nunca baixar vídeos do YouTube nem contornar proteções.
- Chaves secretas só em variáveis de ambiente do servidor.
- O app roda sem Supabase. **Não exponha este servidor na internet**: não há autenticação de usuários (protótipo local).
