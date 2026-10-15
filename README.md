# Cezario's Clips AI

Estúdio para transformar vídeos longos em cortes verticais (9:16) com IA, priorizando processamento local e custo zero.

> **Status:** v0.6. Funcionam de verdade:
> - cadastro de projetos (YouTube ou arquivo);
> - upload validado com ffprobe;
> - persistência local em `.data/`;
> - **transcrição local com faster-whisper** (worker Python);
> - **seleção de cortes com modelo local via Ollama** (`qwen2.5:7b`): cortes em frases completas, gancho copiado da fala, nota por critério (reproduzível) e descarte de repetições;
> - revisão com o vídeo real: cortes recomendados, motivo e nota por critério, aprovar, rejeitar, ajustar e pedir novas sugestões;
> - **renderização dos cortes aprovados com FFmpeg**: MP4 9:16 (rosto detectado localmente com posição fixa, recorte central ou fundo desfocado), legendas em três estilos (com quebra de linha equilibrada), volume uniforme sem distorção, fila com progresso, nova tentativa, prévia e download.
>
> - **Lixeira:** excluir um projeto (ou trocar o vídeo) exige digitar o nome e move tudo para `.data/trash/`, de onde dá para restaurar; só "Excluir definitivamente" apaga.
>
> Não há publicação automática em redes sociais nem pagamentos. Os exemplos em `/demo` são fictícios.

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

## Transcrição, seleção e renderização (worker local)

```bat
workersetup.cmd                  :: uma vez: ambiente Python + faster-whisper
workerstart.cmd download-model   :: uma vez: modelo Whisper (~480 MB)
ollama pull qwen2.5:7b            :: uma vez: modelo de seleção (~4,7 GB)
workerstart.cmd                  :: com o npm run dev aberto em outro terminal
```

Requer Python 3.11+, FFmpeg, Ollama e `CCA_WORKER_TOKEN` no `.env.local`. Veja [worker/README.md](worker/README.md).

## Configuração opcional

Copie `.env.example` para `.env.local`. Nada é obrigatório: sem chaves, a interface funciona com armazenamento local.

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): estrutura, roadmap e regras do projeto
- [worker/README.md](worker/README.md): worker de transcrição, seleção e renderização (instalação, configuração, uso e diagnóstico no Windows)
