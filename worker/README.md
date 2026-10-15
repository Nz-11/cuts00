# Worker local: transcrição, seleção e renderização de cortes

Processo Python que roda **na sua máquina** e faz três etapas, sem API paga e sem enviar nada para a internet:

1. **Transcrição** com o [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CPU).
2. **Seleção de cortes** com um modelo de IA local via [Ollama](https://ollama.com). O padrão é o `qwen2.5:7b`.
3. **Renderização** dos cortes aprovados com o **FFmpeg**: MP4 vertical 9:16 com legendas.

O que ele faz:
1. Consulta a fila da aplicação (`GET /api/worker/jobs`).
2. **Projetos em `transcribing`:**
   - extrai o áudio com o FFmpeg;
   - transcreve em português, com timestamps por trecho e por palavra;
   - salva `.data/media/<id>/transcript.json`;
   - move o projeto para **Seleção de cortes**.
3. **Projetos em `selecting`:**
   - lê o `transcript.json`;
   - pede ao modelo local que sugira trechos;
   - valida cada sugestão;
   - salva `.data/media/<id>/selection.json`;
   - move o projeto para **Revisão**, com os cortes.
4. **Projetos em `rendering`:**
   - corta, reenquadra e legenda cada corte aprovado;
   - grava em `.data/media/<id>/renders/`;
   - move o projeto para **Concluído**.

Só processa arquivos enviados pelo upload da própria aplicação (`.data/media/<id>/`). Nunca baixa vídeos do YouTube e não publica nada nas redes sociais.

## 1. Instalação (Windows, uma vez)

| Ferramenta | Como instalar | Como conferir |
|---|---|---|
| Python 3.11+ (recomendado 3.12) | `winget install -e --id Python.Python.3.12` | `py -3.12 --version` |
| FFmpeg (inclui o ffprobe) | `winget install -e --id Gyan.FFmpeg` | `ffmpeg -version` |
| Ollama | https://ollama.com/download, ou `winget install -e --id Ollama.Ollama` | `ollama --version` |

Depois de instalar o Python, **feche e reabra o terminal**. Se `python` abrir a Microsoft Store, desative os atalhos em *Configurações → Aplicativos → Configurações avançadas → Aliases de execução do aplicativo* (`python.exe` e `python3.exe`).

Na pasta da aplicação:

```bat
worker\setup.cmd                  :: cria worker\.venv e instala o faster-whisper
worker\start.cmd download-model   :: modelo de transcrição (small ≈ 480 MB), uma vez
ollama pull qwen2.5:7b            :: modelo de seleção (≈ 4,7 GB), uma vez
```

- **Modelo Whisper:** vem do repositório oficial `Systran/faster-whisper-<modelo>` e fica em `worker\models\`.
- **Modelo do Ollama:** fica em `%USERPROFILE%\.ollama\models`.
- **Detector de rosto (opcional):** YuNet `face_detection_yunet_2026may.onnx` (229.738 bytes, licença MIT), do repositório oficial [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet). Fica em `worker\models\yunet\`, com o `LICENSE`. SHA-256 conferido com o ponteiro Git LFS oficial: `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`. Roda no `onnxruntime` que o faster-whisper já instala. Sem ele, o enquadramento “Rosto” usa o recorte central.
- **Sem internet depois:** com os dois baixados, o worker funciona offline.

## 2. Configuração

O worker lê o **mesmo `.env.local`** da aplicação. O mínimo necessário:

```env
CCA_WORKER_TOKEN=um-valor-longo-e-aleatorio
```

Para gerar um token:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Opcionais (os valores padrão servem para um PC com 16 GB de RAM e uma placa de vídeo de 6 GB):

| Variável | Padrão | Para que serve |
|---|---|---|
| `CCA_WHISPER_MODEL` | `small` | `tiny`, `base`, `small`, `medium`, `large-v3` ou `large-v3-turbo`. Ao trocar, rode `download-model` de novo. |
| `CCA_WHISPER_LANGUAGE` | `pt` | Idioma do áudio (`pt`, `en`, `es`…) ou `auto`. |
| `CCA_WHISPER_DEVICE` | `cpu` | `cuda` exige as bibliotecas cuBLAS/cuDNN da NVIDIA, que não vêm instaladas. |
| `CCA_WHISPER_COMPUTE` | `int8` | `int8` usa menos memória. Alternativas: `int8_float32` e `float32`. |
| `CCA_WHISPER_THREADS` | metade dos processadores lógicos | Threads de CPU usadas na transcrição. |
| `CCA_WHISPER_BEAM` | `5` | Use `1` para mais velocidade, com um pouco menos de precisão. |
| `CCA_OLLAMA_URL` | `http://127.0.0.1:11434` | Endereço do Ollama. **Só são aceitos endereços deste computador.** |
| `CCA_SELECT_MODEL` | `qwen2.5:7b` | Qualquer modelo instalado no Ollama. Mais leve: `qwen2.5:3b`. |
| `CCA_CLIP_MIN_SEC` / `CCA_CLIP_MAX_SEC` | `15` / `90` | Duração permitida de cada corte. |
| `CCA_SELECT_MAX_CLIPS` | `10` | Máximo de cortes sugeridos por vídeo. |
| `CCA_SELECT_WINDOW_SEC` / `CCA_SELECT_OVERLAP_SEC` | `480` / `60` | Tamanho de cada parte do vídeo enviada ao modelo e a sobreposição entre partes. |
| `CCA_SELECT_NUM_CTX` | `8192` | Contexto do modelo, em tokens. Mais contexto usa mais memória de vídeo. |
| `CCA_APP_URL` | `http://localhost:3000` | Endereço da aplicação. |
| `CCA_DATA_DIR` | `.data` | Precisa ser igual ao da aplicação. |
| `CCA_WORKER_POLL_SECONDS` | `5` | Intervalo entre consultas à fila. |
| `CCA_RENDER_PRESET` | `veryfast` | Velocidade × tamanho do MP4: `ultrafast`, `superfast`, `veryfast`, `faster`, `fast` ou `medium`. |
| `CCA_RENDER_CRF` | `20` | Qualidade do vídeo, de 14 a 32 (menor = melhor e maior). |
| `CCA_FACE_MODEL` | `models/yunet/face_detection_yunet_2026may.onnx` | Modelo do detector de rosto (relativo à pasta `worker`). |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Caminhos do FFmpeg e do ffprobe, se eles não estiverem no PATH. |

As opções "Idioma" e "Modelo" da tela de Configurações ficam só no navegador. **O worker usa as variáveis acima.**

### Consumo medido neste PC

O PC é um i7-4790 com 16 GB de RAM e uma GTX 1660 SUPER de 6 GB.

| Etapa | Velocidade | Memória |
|---|---|---|
| Transcrição (`small`, int8, CPU) | 3 a 4× o tempo real; 1 hora de vídeo leva uns 15 a 20 min | 1 a 2 GB de RAM |
| Renderização (1080×1920, `veryfast`, CRF 20) | uns 2,5 a 3× o tempo real; um corte de 45 s leva uns 16 a 23 s | cerca de 14 a 20 MB por corte de 45 a 55 s |
| Seleção (`qwen2.5:7b`, Q4_K_M) | uns 17 tokens/s; cada parte de 8 min leva uns 35 a 45 s; 1 hora de vídeo leva uns 5 a 7 min | uns 4,9 GB de memória de vídeo (79% do modelo na placa e 21% na CPU) e uns 1 a 2 GB de RAM |

## 3. Uso

São dois terminais, e o Ollama aberto (ele fica no ícone ao lado do relógio):

```bat
npm run dev            :: terminal 1: a aplicação
worker\start.cmd       :: terminal 2: o worker (Ctrl+C para parar)
```

Outras formas de rodar:
- `npm run worker`: o mesmo que `worker\start.cmd`;
- `worker\start.cmd run --once`: processa a fila atual e sai;
- `worker\start.cmd run --no-select`: só transcreve, sem usar o Ollama.

Fluxo:
1. Envie o vídeo.
2. A página mostra "Transcrevendo 01:28 de 04:18".
3. Depois, "Analisando parte 1 de 6 (qwen2.5:7b)".
4. Por fim, **Revisão**:
   - o player toca o vídeo original no intervalo do corte, com um guia do enquadramento 9:16 central;
   - você aprova, rejeita ou ajusta início e fim;
   - "Gerar novas sugestões" descarta as sugestões e pede outra rodada.
5. Em **Renderização 9:16**, no fim da revisão:
   - escolha o enquadramento e a legenda;
   - clique em "Renderizar N cortes aprovados";
   - acompanhe o progresso de cada corte;
   - assista à prévia e use **Baixar MP4**.

## 4. Como a seleção funciona

1. **Frases, não trechos.** O Whisper corta a fala pelo tempo: num vídeo real, só 1 em cada 4 trechos terminava em ponto final. O worker reagrupa as palavras (com os tempos reais) em frases (`units.py`): uma frase termina em `.` `?` `!` `…` ou numa pausa de 1 s; frases com mais de 20 s são divididas na vírgula ou pausa mais forte e marcadas como "continua".
2. As frases são divididas em partes de 8 minutos, com 1 minuto de sobreposição. Cada parte leva 3 frases antes e 2 depois como **contexto sem número**, que o modelo não pode escolher.
3. O modelo devolve, em JSON com esquema fixo:
   - os **números** da frase inicial e da frase final, com citações das primeiras e das últimas palavras;
   - título, gancho (copiado da fala), justificativa e etiquetas;
   - **notas de 1 a 5** para gancho, clareza e contexto, valor, autonomia e ritmo e conclusão.
4. **Os segundos nunca vêm do modelo.** Início = primeira palavra − 0,12 s; fim = última palavra + 0,30 s (o Whisper marca o fim da palavra cedo). A folga nunca invade a palavra vizinha nem passa dos limites do vídeo.
5. **Ajustes automáticos das bordas** (aparecem na revisão):
   - vinhetas e pedidos de inscrição nas pontas são removidos;
   - começo no meio de uma frase volta ao começo dela (ou avança para a próxima, se não couber);
   - começo com "porque", "mas", "então", "só que"… recua uma frase para dar contexto;
   - fim no meio de uma frase avança até a conclusão; para caber no máximo, o fim recua para o fim de uma frase.
6. **Fidelidade:** se o gancho não for uma fala literal do corte, é trocado pela frase real mais parecida dos primeiros 15 s. Título com número que não aparece na fala gera alerta.
7. **Validação:** a sugestão é descartada (motivo no log) se as frases estão fora da parte ou invertidas, a duração fica fora de 15–90 s, faltam título, gancho ou justificativa, as notas não são inteiras, ou a citação inicial aponta para uma frase a mais de 1 de distância do número.
8. **Pontuação (`scoring.py`), reproduzível:**

   | Critério | Peso |
   |---|---|
   | Gancho | 25% |
   | Clareza e contexto | 20% |
   | Valor (informação ou entretenimento) | 25% |
   | Autonomia | 15% |
   | Ritmo e conclusão | 15% |

   `base = soma(peso × (nota − 1) / 4) × 100` e `final = base − 30 × redundância`, arredondado (conta em inteiros, idêntica em `src/lib/clip-analysis.ts`, que a refaz ao receber os cortes).
   - **Regras objetivas** baixam notas infladas: começo ou fim no meio de frase limitam autonomia ou ritmo a 2; 5+ referências à tela ("aqui", "olha", "clicar") por 100 palavras tiram 1 ponto de autonomia (2 a partir de 8); 6+ muletas ("né", "tipo") por 100 palavras tiram 1 de ritmo.
   - **Redundância:** maior valor entre a sobreposição no tempo e a semelhança de vocabulário com um corte mais bem avaliado. Acima de 50% o corte é descartado; abaixo, perde até 30 pontos.
   - É uma **estimativa editorial**, não uma previsão de visualizações.
9. Entram os 10 melhores pela nota final.

**Medição num vídeo real (19 min, tutorial):** a versão anterior gerou 6 cortes, com só 1 de 6 terminando em frase completa e um par de cortes sobrepostos; a nova gerou 6, com 6 de 6 começando e terminando em frase completa e nenhum gancho inventado. A seleção levou 350 s, contra 257 s antes, porque a resposta do modelo ficou maior. Limitação: o `qwen2.5:7b` dá notas altas para quase tudo, por isso as regras objetivas e a redundância são as que mais diferenciam os cortes.

## 5. Como a renderização funciona

1. **Pedido.** Só cortes **aprovados** podem ser renderizados. O pedido grava em cada corte as opções e uma **cópia dos timestamps**; ajustes feitos depois marcam a renderização como desatualizada.
2. **Validação, na aplicação e de novo no worker:**
   - opções de uma lista fechada: enquadramento `face`, `crop` ou `blur`, legenda `classic`, `keywords`, `highlight` ou `none`;
   - números finitos, início ≥ 0 e fim ≤ duração do vídeo;
   - duração entre 1 s e 10 min;
   - identificador do corte sem caracteres especiais.
3. **Comando do FFmpeg.**
   - É montado só com esses valores, em lista de argumentos e sem shell.
   - **Nenhum texto vindo da aplicação vira argumento ou filtro.**
   - A legenda entra por um arquivo `captions.ass` com caminho relativo, e chaves e barras do texto são neutralizadas.
4. **Corte e sincronia.** Busca precisa (`-ss` antes da entrada, com recodificação) e duração exata (`-t`). Testado com um flash e um bipe no mesmo instante: a diferença no corte ficou abaixo de 0,1 s.
5. **Enquadramento 1080×1920, sem distorção:**
   - **Rosto (padrão; para pessoas falando diante da câmera):** mesma escala do recorte central (sem zoom), mas com a janela 9:16 numa **posição fixa** escolhida para o corte inteiro (`framing.py`):
     - **rosto pequeno (menos de 1/3 da altura)**, como a câmera no canto de uma gravação de tela: o recorte esconderia o resto, então usa o **fundo desfocado**. No vídeo real medido, a câmera sobre a tela ocupava 24–26% da altura; a pessoa falando para a câmera, 46–59%;
     - 6 a 15 quadros espaçados do trecho são analisados pelo YuNet (rostos com confiança ≥ 0,7 e altura ≥ 6% do quadro; uma 2ª passada em resolução menor pega rostos muito grandes);
     - o rosto principal é o maior de cada quadro; a posição é a **mediana** das posições, o que ignora quadros isolados;
     - rostos de tamanho parecido que cabem juntos na janela são enquadrados juntos; se não cabem, fica o principal e a nota sugere “Fundo desfocado”;
     - a altura inteira do vídeo é mantida, então rosto e parte de cima do corpo ficam na tela;
     - **volta ao recorte central** se o rosto aparece em menos de 60% dos quadros, se ficaria fora da janela fixa em mais de 10% deles (pessoa que se move, câmera que troca de lado), se o vídeo já é vertical, ou se o modelo não existe ou falha. A renderização nunca para por causa do detector;
     - a decisão aparece no painel, abaixo da prévia (ex.: “Enquadrado no rosto principal, posição fixa em 30% da largura”).
   - **Centralizado:** escala até cobrir a tela e corta as laterais por igual.
   - **Fundo desfocado (indicado para tutoriais e gravações de tela):** a imagem inteira é centralizada (um vídeo 16:9 ocupa 1080×608) sobre a mesma imagem ampliada e desfocada.
   - **Resolução da fonte:** antes de renderizar, o worker calcula quanto a imagem será ampliada. Se o recorte 9:16 exigiria mais de 3× (ex.: fonte 640×360 → 5,3× em 1080×1920), a saída fica em **720×1280** (3,6×): ampliar mais não cria detalhe. O fundo desfocado amplia bem menos (1,7× na mesma fonte). Acima de 2×, a ampliação é informada no painel; a revisão também avisa antes de renderizar. Nenhum filtro recupera detalhes que não existem na fonte.
6. **Legendas** a partir das palavras do `transcript.json`, com tempos relativos ao corte:
   - cada legenda começa na primeira palavra falada, fecha em ponto final, vírgula ou pausa de 0,6 s, fica pelo menos 0,7 s na tela e nunca se sobrepõe à seguinte;
   - no máximo 2 linhas equilibradas, sem terminar linha ou legenda em "de", "que", "o"…;
   - **Clássica:** até 8 palavras (24 caracteres por linha), Arial branca com contorno, embaixo.
   - **Palavras-chave:** como a clássica, com no máximo 1 palavra em amarelo por legenda: números e palavras do título e das etiquetas do corte (a mesma palavra não se repete em seguida).
   - **Destaque:** 3 palavras por vez, em MAIÚSCULAS e Arial Black, com a palavra falada em amarelo.
7. **Áudio natural:** o volume do trecho é medido (`loudnorm`) e recebe **um ganho único** para chegar perto de −14 LUFS, limitado a ±12 dB e sem levar o pico acima de −1 dBTP. Não há compressor nem limitador; fades de 20 ms evitam estalos nos pontos de corte.
8. **Codificação compatível:** H.264 High em yuv420p, no máximo 60 quadros por segundo, AAC estéreo a 48 kHz e `+faststart`, para tocar no navegador sem baixar o arquivo inteiro.
9. **Conferência antes de salvar.** O worker gera o arquivo em `.data\tmp\` e confere com o ffprobe (H.264 no tamanho planejado, AAC e duração). Só então ele vai para `renders/<corte>-<hash>.mp4`.
10. **Arquivos isolados.** O hash reflete o vídeo, o intervalo e as opções. **Renderizar de novo com outras opções cria outro arquivo**; o vídeo original e as renderizações anteriores nunca são sobrescritos.

## 6. Garantias

- **Nada é processado duas vezes.**
  - Transcrição: se o worker cair depois de salvar o `transcript.json`, o arquivo é reaproveitado (mesmo vídeo, modelo e idioma).
  - Seleção: cada parte concluída fica salva em `selection.json`. Ao reiniciar, só as partes que faltam vão para o modelo. Se o resultado final já estava salvo, ele é reenviado sem chamar o modelo.
- **Rodadas.**
  - "Gerar novas sugestões" e "Tentar selecionar de novo" começam uma rodada nova, com outra semente; a transcrição é mantida.
  - Reiniciar o worker continua a rodada atual.
  - A identificação da rodada inclui o conteúdo da transcrição, o modelo, a versão das instruções e os limites.
- **Ollama desligado ou modelo ausente.**
  - O projeto **continua na fila de seleção**, sem falhar.
  - O worker avisa no log e tenta de novo a cada consulta.
  - Se o Ollama cair no meio, a página mostra "Ollama indisponível — a seleção continua quando ele voltar".
- **Respostas inválidas.**
  - JSON quebrado ou erro do Ollama: até 3 tentativas por parte, variando a temperatura.
  - Se todas as partes falharem, ou nenhum corte válido sobrar, o projeto vai para "Falhou" na etapa de seleção, com a opção **"Tentar selecionar de novo"**.
  - A transcrição nunca é apagada.
- **Renderização:**
  - **Falha de um corte:** ele fica "Falhou", com a mensagem, e os demais continuam.
  - **Concluído:** se ao menos um corte ficar pronto, o projeto vai para "Concluído" e a interface oferece **"Tentar novamente"** para os que falharam.
  - **Falha total:** se nenhum ficar pronto, o projeto vai para "Falhou" na etapa de renderização.
  - **Queda do worker:** um arquivo final já gerado e válido é reaproveitado sem renderizar de novo.
  - **Projeto excluído no meio:** o FFmpeg é interrompido e nada fica na pasta do projeto.
- **Quedas são recuperáveis.** Os temporários de uma transcrição ou renderização interrompida (`.data\tmp\`) são apagados ao reiniciar.
- **Projeto alterado durante o trabalho.** Se ele for excluído ou mudar de estado, a aplicação responde 404/409 e o worker para sem gravar nada.
- **Um worker por vez.** Um arquivo de trava (`.data\worker.lock`) impede um segundo worker.
- **Proteção do token.** Ele só vai no cabeçalho `Authorization`, nunca aparece em logs e não é enviado a proxies nem seguido em redirecionamentos.
- **Isolamento.**
  - O Ollama só é contatado em endereços locais.
  - O vídeo para o player é servido por `GET /api/projects/:id/media`.
  - Os MP4 são servidos por `GET /api/projects/:id/renders/:clipId` (com `?download=1` para salvar), que entrega apenas o arquivo registrado na renderização concluída do próprio corte, dentro de `renders/`.
  - O worker só pode registrar arquivos `renders/<nome>.mp4` que existam no disco com o tamanho informado.

## 7. Diagnóstico de erros

Comece sempre por:

```bat
worker\start.cmd check
```

Ele confere:
- Python, FFmpeg, faster-whisper e o modelo Whisper;
- **Ollama e o modelo de seleção**;
- pasta de dados, token e conexão com a aplicação.

Os logs ficam em `worker\logs\worker.log`, e a tela de Configurações mostra se o Ollama está rodando.

| Sintoma | Causa provável | Solução |
|---|---|---|
| `python` abre a Microsoft Store | Atalhos de execução do Windows | Desative os aliases (veja a seção 1) ou use `py -3.12` |
| `Worker não instalado` | Falta o `worker\.venv` | `worker\setup.cmd` |
| `O modelo Whisper 'small' não está em…` | O modelo não foi baixado | `worker\start.cmd download-model` |
| `CCA_WORKER_TOKEN não definido` | Falta a variável no `.env.local` | Crie o token (seção 2) |
| `API do worker está desligada (503)` | A aplicação foi iniciada antes do token existir | Reinicie o `npm run dev` |
| `Token recusado (401)` | Tokens diferentes, por exemplo uma variável do Windows sobrepondo o `.env.local` | Use um só valor e reinicie a aplicação |
| `Sem resposta de http://localhost:3000` | A aplicação não está rodando | `npm run dev`, ou ajuste `CCA_APP_URL` |
| `Seleção de cortes pausada: Ollama sem resposta…` | O Ollama está fechado | Abra o Ollama pelo menu Iniciar; o worker retoma sozinho |
| `…não está no Ollama (rode: ollama pull …)` | O modelo de seleção não foi baixado | `ollama pull qwen2.5:7b` |
| `CCA_OLLAMA_URL precisa apontar para este computador` | Foi configurado um endereço externo | Use `http://127.0.0.1:11434` |
| Seleção muito lenta | O modelo não coube na placa de vídeo | Feche jogos ou navegadores pesados, reduza `CCA_SELECT_NUM_CTX` para `6144`, ou use `qwen2.5:3b` |
| "Nenhum trecho adequado foi encontrado" | Os limites de duração não combinam com o vídeo | Ajuste `CCA_CLIP_MIN_SEC`/`CCA_CLIP_MAX_SEC` e use "Tentar selecionar de novo" |
| "O modelo local não gerou respostas válidas" | O modelo errou o formato 3 vezes seguidas em todas as partes | "Tentar selecionar de novo"; se persistir, troque o modelo |
| Corte com título de outro assunto | Limitação do modelo (raro após a conferência por citação) | Rejeite o corte ou peça novas sugestões |
| `Já existe um worker rodando…` | Há outra janela do worker aberta | Feche a outra janela |
| `FFmpeg não encontrado` | O FFmpeg não está no PATH | Instale-o (seção 1) ou defina `FFMPEG_PATH` |
| `Memória insuficiente…` | Modelo grande demais para a memória livre | Use modelos menores ou feche outros programas |
| Corte "Falhou" com `FFmpeg não encontrado` | O FFmpeg não está no PATH do worker | Instale-o ou defina `FFMPEG_PATH`; depois clique em "Tentar novamente" |
| `O vídeo gerado não está em H.264 1080×1920` ou `Duração gerada… diferente` | O arquivo de origem tem problemas, ou faltou disco | Confira o espaço livre e o arquivo original; tente de novo |
| "A transcrição não foi encontrada para gerar as legendas" | O `transcript.json` sumiu | Renderize com "Sem legenda" ou transcreva de novo |
| Legenda sem acentos ou com fonte diferente | Falta a Arial ou a Arial Black do Windows | Instale as fontes; o FFmpeg usa as do sistema |
| "O corte foi ajustado depois desta renderização" | Início ou fim foram mudados depois de renderizar | Renderize de novo (o arquivo antigo continua na pasta) |
| Renderização lenta | Preset pesado ou CPU ocupada | `CCA_RENDER_PRESET=superfast` |
| Vídeo não toca na revisão | O navegador não reproduz o formato (`.mkv`, alguns `.mov`) | Os cortes continuam válidos; prefira enviar `.mp4` |
| Fica em "Transcrevendo" ou "Seleção" sem avançar | Worker ou Ollama fechados | Abra-os de novo: o trabalho é retomado |

## 8. Testes

```bat
npm run test:worker
```

São 79 testes:
- configuração, incluindo o bloqueio de endereços externos para o Ollama;
- cliente da API, com 401, 404/409 e 503;
- transcrição com FFmpeg real e transcritor falso: reaproveitamento, retomada, cancelamento, caminho inseguro, vídeo sem áudio e trava;
- **seleção com um Ollama falso:**
  - divisão em partes e leitura do JSON;
  - validação dos timestamps (limites do vídeo, duração, janela e citação);
  - remoção de duplicatas;
  - persistência e retomada após queda;
  - reaproveitamento do resultado final e rodadas novas;
  - respostas inválidas e erros 500;
  - Ollama desligado e modelo ausente;
- **renderização com FFmpeg real** (vídeos sintéticos):
  - duração, H.264 1080×1920 yuv420p, AAC 48 kHz e `+faststart`;
  - **sincronia** com um flash e um bipe na fonte, que precisam cair no mesmo instante do corte;
  - fundo desfocado sem distorção (a faixa nítida tem a altura de 16:9 e fica centralizada) e recorte que preenche a tela;
  - fontes verticais e horizontais;
  - legendas visíveis nos pixels, nos dois estilos;
  - escape de texto ASS, palavras relativas ao corte e validação de opções e timestamps;
  - comando sem shell;
  - falha parcial e total, nova tentativa, reaproveitamento após queda e arquivo corrompido;
  - cancelamento com projeto excluído;
  - original intacto, arquivos distintos sem sobrescrita e caminho fora da pasta de dados;
- **testes reais**, pulados se o modelo não estiver instalado:
  - transcrição com a voz pt-BR do Windows;
  - seleção com o `qwen2.5:7b` sobre uma transcrição **fictícia** escrita para testes (`tests/fixtures/`).

## Contrato da API

As ações existentes não mudaram. A renderização acrescentou a ação `clip`.

Todas as chamadas enviam `Authorization: Bearer $CCA_WORKER_TOKEN`. Sem a variável na aplicação, a API responde `503`.

### `GET /api/worker/jobs`

Lista os projetos em `transcribing`, `selecting` ou `rendering`, do mais antigo para o mais novo. Em `rendering`, inclui `clips`: os cortes aprovados com renderização pedida, cada um com `render: { state, framing, captions, startSec, endSec, … }`.

```json
{ "ok": true, "jobs": [{
  "projectId": "p_…", "status": "transcribing",
  "job": { "state": "queued", "progress": 0 },
  "media": { "storedPath": "media/p_…/source-….mp4", "absolutePath": "C:\\…\\.data\\media\\p_…\\source-….mp4", "durationSec": 5420, "hasAudio": true }
}]}
```

### `POST /api/worker/projects/:id`

```jsonc
{ "action": "progress", "progress": 0.4, "message": "Transcrevendo 12:00 de 30:00" }   // marca o job como "running"
{ "action": "transition", "to": "selecting", "note": "Transcrição concluída" }
{ "action": "transition", "to": "review", "clips": [{ "id": "c1", "title": "…", "startSec": 812, "endSec": 869,
  "score": 94, "reason": "…", "hook": "…", "transcript": "…", "tags": ["gancho"] }] }
{ "action": "transition", "to": "failed", "error": { "stage": "transcribe" | "select" | "render", "message": "…" } }
{ "action": "transition", "to": "completed", "note": "…" }   // 409 se nenhum corte estiver renderizado
// Renderização de cada corte (só durante "rendering"):
{ "action": "clip", "clipId": "c1", "state": "running", "progress": 0.4 }
{ "action": "clip", "clipId": "c1", "state": "done", "file": "renders/c1-1a2b3c4d5e.mp4", "sizeBytes": 14343536, "durationSec": 42.79 }
{ "action": "clip", "clipId": "c1", "state": "failed", "error": "…" }
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

### Formato de `selection.json`

```jsonc
{
  "version": 1, "projectId": "p_…", "createdAt": "…", "updatedAt": "…", "completedAt": "…",
  "key": { "transcriptSha256": "…", "model": "qwen2.5:7b", "promptVersion": 5, "run": 1,
           "params": { "clipMinSec": 15, "clipMaxSec": 90, "maxClips": 10, "windowSec": 480, "overlapSec": 60 } },
  "windowCount": 6,
  "windows": { "0": { "status": "done", "range": [0, 87], "attempts": 1,
                      "candidates": [{ "title": "…", "startSec": 25.30, "endSec": 76.73, "segments": [4, 11], "analysis": { "…": "…" } }],
                      "rejected": ["#2: duração 104.0s fora de 15–90s"] } },
  "final": [{ "id": "c1", "title": "…", "startSec": 25.30, "endSec": 76.73, "score": 72, "reason": "…", "hook": "…", "transcript": "…", "tags": ["golpe"],
               "analysis": { "version": 1, "criteria": { "hook": 4, "clarity": 4, "value": 4, "standalone": 3, "pacing": 3 }, "redundancyPct": 0,
                             "boundaries": { "start": "sentence", "end": "sentence" }, "adjustments": ["Início movido para o começo da frase."], "warnings": [] } }]
}
```

## Próximas melhorias possíveis

- Detectar gravação de tela com câmera no canto e sugerir “Fundo desfocado” automaticamente.
- Codificação pela placa de vídeo (`h264_nvenc`, já disponível neste FFmpeg) como opção.
- Estilo de legenda personalizado a partir das preferências da tela de Configurações.
