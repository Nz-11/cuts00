# Worker local de transcrição

Processo Python que roda **na sua máquina** e transcreve os vídeos enviados à aplicação, usando o [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (gratuito, CPU, sem API paga).

O que ele faz:
1. Consulta a fila da aplicação (`GET /api/worker/jobs`).
2. Pega **somente** projetos em `transcribing` cujo arquivo está em `.data/media/<id>/`, ou seja, enviados pelo upload da própria aplicação.
3. Extrai o áudio com o FFmpeg (WAV mono, 16 kHz).
4. Transcreve em português, com timestamps por trecho e por palavra.
5. Salva `.data/media/<id>/transcript.json` e move o projeto para **Seleção de cortes**.

A seleção por IA e a renderização **ainda não existem**: depois da transcrição, o projeto aguarda em "Seleção de cortes". O worker nunca baixa vídeos do YouTube.

## 1. Instalação (Windows, uma vez)

Pré-requisitos:

| Ferramenta | Como instalar | Como conferir |
|---|---|---|
| Python 3.11+ (recomendado 3.12) | `winget install -e --id Python.Python.3.12` | `py -3.12 --version` |
| FFmpeg (inclui o ffprobe) | `winget install -e --id Gyan.FFmpeg` | `ffmpeg -version` |

Depois de instalar o Python, **feche e reabra o terminal**. Se `python` abrir a Microsoft Store, desative os atalhos em *Configurações → Aplicativos → Configurações avançadas → Aliases de execução do aplicativo* (`python.exe` e `python3.exe`).

Na pasta da aplicação:

```bat
worker\setup.cmd                  :: cria worker\.venv e instala o faster-whisper
worker\start.cmd download-model   :: baixa o modelo (small ≈ 480 MB), uma única vez
```

O modelo vem do repositório oficial `Systran/faster-whisper-<modelo>` no Hugging Face e fica em `worker\models\` (fora do Git). Depois disso, o worker funciona **sem internet**.

## 2. Configuração

O worker lê o **mesmo `.env.local`** da aplicação. O mínimo necessário:

```env
CCA_WORKER_TOKEN=um-valor-longo-e-aleatorio
```

Para gerar um token:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Opcionais (os valores padrão servem para um PC com 16 GB de RAM):

| Variável | Padrão | Para que serve |
|---|---|---|
| `CCA_WHISPER_MODEL` | `small` | `tiny`, `base`, `small`, `medium`, `large-v3` ou `large-v3-turbo`. Ao trocar, rode `download-model` de novo. |
| `CCA_WHISPER_LANGUAGE` | `pt` | Idioma do áudio (`pt`, `en`, `es`…) ou `auto`. |
| `CCA_WHISPER_DEVICE` | `cpu` | `cuda` exige as bibliotecas cuBLAS/cuDNN da NVIDIA, que não vêm instaladas. |
| `CCA_WHISPER_COMPUTE` | `int8` | `int8` usa menos memória. Alternativas: `int8_float32` e `float32`. |
| `CCA_WHISPER_THREADS` | metade dos processadores lógicos | Threads de CPU usadas na transcrição. |
| `CCA_WHISPER_BEAM` | `5` | Use `1` para mais velocidade, com um pouco menos de precisão. |
| `CCA_APP_URL` | `http://localhost:3000` | Endereço da aplicação. |
| `CCA_DATA_DIR` | `.data` | Precisa ser igual ao da aplicação. |
| `CCA_WORKER_POLL_SECONDS` | `5` | Intervalo entre consultas à fila. |
| `FFMPEG_PATH` | `ffmpeg` | Caminho do FFmpeg, se ele não estiver no PATH. |

As opções "Idioma" e "Modelo" da tela de Configurações ficam só no navegador. **O worker usa as variáveis acima.**

Consumo medido neste PC (i7-4790, 4 núcleos, modelo `small`, int8, CPU): cerca de **3 a 4× o tempo real**. Um vídeo de 1 hora leva perto de 15 a 20 minutos, usando em torno de 1 a 2 GB de RAM.

## 3. Uso

São dois terminais:

```bat
npm run dev            :: terminal 1: a aplicação
worker\start.cmd       :: terminal 2: o worker (Ctrl+C para parar)
```

Também existem `npm run worker` (o mesmo que `worker\start.cmd`) e `worker\start.cmd run --once`, que processa a fila atual e sai.

Fluxo: crie um projeto → envie o vídeo → a página do projeto mostra "Transcrevendo 01:28 de 04:18" e se atualiza sozinha → "Seleção de cortes", com a nota "Transcrição concluída: N trechos, M palavras" no histórico.

## 4. Garantias

- **Nada é processado duas vezes.** Depois da transcrição, o projeto sai de `transcribing`. Se o worker cair entre salvar o `transcript.json` e avisar a aplicação, ele reaproveita o arquivo, desde que sejam o mesmo vídeo, o mesmo modelo e o mesmo idioma.
- **Quedas são recuperáveis.** Se o worker for fechado no meio, o projeto continua "Em andamento". Ao reiniciar, o worker retoma a transcrição e apaga os temporários que sobraram (`.data\tmp\`). Testado matando o processo aos 55%.
- **Falhas aparecem na interface.** Exemplos: arquivo sumiu, vídeo sem áudio, nenhuma fala detectada ou falta de memória. Nesses casos o projeto vai para "Falhou", com a mensagem, e a página oferece **"Tentar transcrever de novo"** (mantém o arquivo) ou **"Recomeçar com outro arquivo"**.
- **Projeto alterado durante o trabalho.** Se o projeto for excluído ou mudar de estado, a aplicação responde 404/409 e o worker para sem gravar nada.
- **Um worker por vez.** Um arquivo de trava (`.data\worker.lock`) impede um segundo worker na mesma pasta de dados.
- **Proteção do token.** O token só vai no cabeçalho `Authorization`, nunca aparece em logs ou mensagens e não é enviado a proxies nem seguido em redirecionamentos.
- **Somente arquivos locais.** O caminho do arquivo é conferido: precisa estar em `<dados>\media\<id do projeto>\`.

## 5. Diagnóstico de erros

Comece sempre por:

```bat
worker\start.cmd check
```

Ele confere o Python, o FFmpeg, o faster-whisper, o modelo, a pasta de dados, o token e a conexão com a aplicação. Os logs ficam em `worker\logs\worker.log`.

| Sintoma | Causa provável | Solução |
|---|---|---|
| `python` abre a Microsoft Store | Atalhos de execução do Windows | Desative os aliases (veja a seção 1) ou use `py -3.12` |
| `Worker não instalado` | Falta o `worker\.venv` | `worker\setup.cmd` |
| `O modelo Whisper 'small' não está em…` | O modelo não foi baixado | `worker\start.cmd download-model` |
| `CCA_WORKER_TOKEN não definido` | Falta a variável no `.env.local` | Crie o token (seção 2) |
| `API do worker está desligada (503)` | A aplicação foi iniciada antes do token existir | Reinicie o `npm run dev` |
| `Token recusado (401)` | Tokens diferentes; por exemplo, um `CCA_WORKER_TOKEN` definido no ambiente do Windows sobrepondo o do `.env.local` | Use um só valor e reinicie a aplicação |
| `Sem resposta de http://localhost:3000` | A aplicação não está rodando ou usa outra porta | `npm run dev`, ou ajuste `CCA_APP_URL` |
| `Já existe um worker rodando…` | Há outra janela do worker aberta | Feche a outra; se não houver nenhuma, reinicie o PC |
| `FFmpeg não encontrado` | O FFmpeg não está no PATH | Instale-o (seção 1) ou defina `FFMPEG_PATH` |
| `Memória insuficiente…` | Modelo grande demais para a RAM livre | `CCA_WHISPER_MODEL=base`, ou feche outros programas |
| `Nenhuma fala foi detectada` | O vídeo não tem voz audível | Confira o áudio do arquivo original |
| Acentos estranhos no console | Página de código do terminal | O worker já força UTF-8; o log em `worker\logs` está sempre correto |
| Fica em "Transcrevendo" sem avançar | Worker fechado no meio | Abra o worker de novo: ele retoma sozinho |

## 6. Testes

```bat
npm run test:worker
```

São 25 testes:
- configuração;
- cliente da API, com servidor falso, incluindo 401, 404/409 e 503;
- fluxo completo com FFmpeg real e transcritor falso, cobrindo reaproveitamento, retomada, cancelamento, caminho inseguro, vídeo sem áudio e trava;
- leitura do WAV;
- uma **transcrição real**, com fala sintetizada pela voz pt-BR do Windows. Ela é pulada se o modelo não estiver baixado.

## Contrato da API (não alterado)

Todas as chamadas enviam `Authorization: Bearer $CCA_WORKER_TOKEN`. Sem a variável na aplicação, a API responde `503`.

### `GET /api/worker/jobs`

Lista os projetos em `transcribing`, `selecting` ou `rendering`, do mais antigo para o mais novo. O worker atual usa apenas os que estão em `transcribing`.

```json
{ "ok": true, "jobs": [{
  "projectId": "p_…", "status": "transcribing",
  "job": { "state": "queued", "progress": 0 },
  "media": { "storedPath": "media\\p_…\\source-….mp4", "absolutePath": "C:\\…\\.data\\media\\p_…\\source-….mp4", "durationSec": 5420, "hasAudio": true }
}]}
```

### `POST /api/worker/projects/:id`

```jsonc
{ "action": "progress", "progress": 0.4, "message": "Transcrevendo 12:00 de 30:00" }   // marca o job como "running"
{ "action": "transition", "to": "selecting", "note": "Transcrição concluída" }
{ "action": "transition", "to": "review", "clips": [{ "id": "c1", "title": "…", "startSec": 812, "endSec": 869,
  "score": 94, "reason": "…", "hook": "…", "transcript": "…", "tags": ["gancho"] }] }
{ "action": "transition", "to": "failed", "error": { "stage": "transcribe", "message": "…" } }
```

Transições inválidas recebem `409` (veja `src/lib/project-status.ts`). Um projeto inexistente recebe `404`.

### Formato de `transcript.json`

Os segmentos seguem `TranscriptSegment` / `TranscriptWord`, definidos em `src/lib/pipeline.ts`.

```jsonc
{
  "version": 1, "projectId": "p_…", "createdAt": "2026-…Z",
  "source": { "file": "source-….mp4", "sizeBytes": 123, "mtimeNs": 123 },
  "engine": "faster-whisper", "model": "small", "device": "cpu", "computeType": "int8",
  "requestedLanguage": "pt", "language": "pt", "languageProbability": 1,
  "durationSec": 25.81, "processingSec": 6.8,
  "segments": [{ "id": 0, "startSec": 0, "endSec": 1.18, "text": "Olá, pessoal.",
                 "words": [{ "word": "Olá,", "startSec": 0, "endSec": 0.4, "probability": 0.91 }] }],
  "text": "Olá, pessoal. …"
}
```

## Próximas etapas

1. `selecting`: escolher trechos a partir do `transcript.json` (modelo local; API paga **somente com autorização**) → `transition review` com `clips`.
2. `rendering`: cortar, reenquadrar para 9:16 e queimar legendas com o FFmpeg → MP4 em `.data/media/:id/clips/` → `transition completed`.
