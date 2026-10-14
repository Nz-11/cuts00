# Cezario's Clips AI

Estúdio para transformar vídeos longos em cortes verticais (9:16) com IA, priorizando processamento local e custo zero.

> **Status:** v0.3. Funcionam de verdade:
> - cadastro de projetos (YouTube ou arquivo);
> - upload validado com ffprobe;
> - persistência local em `.data/`;
> - **transcrição local com faster-whisper** (worker Python).
>
> A seleção por IA e a renderização ainda **não** existem. Os exemplos em `/demo` são fictícios.

## Como rodar

```bash
npm install
npm run dev        # http://localhost:3000
```

Outros comandos:

```bash
npm test           # testes (node --test)
npm run lint       # ESLint
npm run typecheck  # verificação de tipos
npm run check      # os três acima
npm run build      # build de produção
npm run start      # servir o build
npm run test:worker # testes do worker Python
```

## Transcrição (worker local)

```bat
workersetup.cmd                  :: uma vez: ambiente Python + faster-whisper
workerstart.cmd download-model   :: uma vez: modelo Whisper (~480 MB)
workerstart.cmd                  :: com o npm run dev aberto em outro terminal
```

Requer Python 3.11+, FFmpeg e `CCA_WORKER_TOKEN` no `.env.local`. Veja [worker/README.md](worker/README.md).

## Configuração opcional

Copie `.env.example` para `.env.local`. Nada é obrigatório: sem chaves, a interface funciona com armazenamento local.

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): estrutura, roadmap e regras do projeto
- [worker/README.md](worker/README.md): worker de transcrição (instalação, configuração, uso e diagnóstico no Windows)
