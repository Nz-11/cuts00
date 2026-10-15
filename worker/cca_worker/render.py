"""Renderização dos cortes aprovados com o FFmpeg local.

Para cada corte aprovado com renderização pedida (projeto em `rendering`):
  1. Valida o pedido (opções de uma lista fechada, timestamps dentro do vídeo).
  2. Gera as legendas em ASS a partir das palavras do `transcript.json`
     (legendas curtas, no máximo 2 linhas equilibradas, sincronizadas palavra a palavra).
  3. Corta e reenquadra para 9:16 (1080×1920) sem distorcer:
       face → como o crop, com a janela fixa no rosto principal (framing.py),
              ou no centro quando a detecção não é confiável;
       crop → escala até cobrir a tela e corta o excesso (centro);
       blur → imagem inteira centralizada sobre a mesma imagem ampliada e desfocada.
  4. Mede o volume do trecho e aplica um ganho único (sem compressão) para
     chegar perto de -14 LUFS sem passar de -1 dBTP, com fades de 20 ms nas
     pontas para não estalar.
  5. Codifica em H.264 (yuv420p, +faststart) + AAC: toca em navegadores e redes sociais.
  6. Confere o resultado com o ffprobe e só então o move para
     `.data/media/<id>/renders/<corte>-<hash>.mp4`. O hash reflete o vídeo de
     origem, o intervalo e as opções: nada sobrescreve o original ou outro corte.

O comando do FFmpeg é montado só com valores validados; nenhum texto vindo da
aplicação vira argumento ou filtro. O texto das legendas vai para um arquivo
ASS com caracteres de controle neutralizados.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .api import AppUnreachable, JobGone, WorkerApi
from .config import Settings
from .framing import FACE_VERSION, FaceDetector, FramingDecision, YuNetDetector, analyze
from .runner import TRANSCRIPT_FILE, JobOutcome, UnsafeJob, resolve_source, source_fingerprint, work_root
from .scoring import STOPWORDS
from .units import norm, norm_words

log = logging.getLogger("cca_worker")

RENDER_VERSION = 3  # 2: legendas, volume e fades; 3: tamanho da saída conforme a resolução da fonte
OUT_W, OUT_H = 1080, 1920
LOW_W, LOW_H = 720, 1280
# Acima desta ampliação, a saída cai para 720×1280: ampliar mais não cria detalhe,
# só deixa o arquivo maior. (Fonte 360p no recorte 9:16: 5,3× em 1080p → 3,6× em 720p.)
MAX_UPSCALE = 3.0
NOTE_UPSCALE = 2.0  # abaixo disso (ex.: recorte de 1080p, 1,8×) a ampliação é normal e não gera aviso
FRAMINGS = ("face", "crop", "blur")
CAPTIONS = ("classic", "keywords", "highlight", "none")
MAX_RENDER_SEC = 600
CLIP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
RENDERS_DIR = "renders"
PROGRESS_INTERVAL_SEC = 2.0


class RenderError(Exception):
    """Falha ao renderizar um corte (mensagem mostrada ao usuário)."""


class RenderCancelled(Exception):
    pass


@dataclass(frozen=True)
class RenderSpec:
    clip_id: str
    start: float
    end: float
    framing: str
    captions: str

    @property
    def duration(self) -> float:
        return self.end - self.start


# ---------------------------------------------------------------------------
# Validação


def validate_clip(clip: dict[str, Any], media_duration: float | None) -> RenderSpec:
    clip_id = clip.get("id")
    if not isinstance(clip_id, str) or not CLIP_ID_RE.match(clip_id):
        raise RenderError("Identificador de corte inválido.")
    if clip.get("decision") != "approved":
        raise RenderError("Só cortes aprovados podem ser renderizados.")
    render = clip.get("render")
    if not isinstance(render, dict):
        raise RenderError("Renderização não pedida para este corte.")
    framing, captions = render.get("framing"), render.get("captions")
    if framing not in FRAMINGS:
        raise RenderError(f"Enquadramento inválido: {framing!r}.")
    if captions not in CAPTIONS:
        raise RenderError(f"Estilo de legenda inválido: {captions!r}.")
    start, end = render.get("startSec"), render.get("endSec")
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        raise RenderError("Timestamps ausentes ou não numéricos.")
    start, end = float(start), float(end)
    if not (math.isfinite(start) and math.isfinite(end)):
        raise RenderError("Timestamps inválidos.")
    if start < 0:
        raise RenderError("O corte começa antes do início do vídeo.")
    if media_duration is not None and media_duration > 0:
        if end > media_duration + 0.05:
            raise RenderError(f"O corte termina em {end:.1f}s, depois do fim do vídeo ({media_duration:.1f}s).")
        end = min(end, media_duration)
    if end - start < 1:
        raise RenderError("O corte dura menos de 1 segundo.")
    if end - start > MAX_RENDER_SEC:
        raise RenderError(f"O corte dura mais de {MAX_RENDER_SEC // 60} minutos.")
    return RenderSpec(clip_id, round(start, 3), round(end, 3), framing, captions)


def output_name(spec: RenderSpec, fingerprint: dict[str, Any], offset: float = 0.5, effective: str | None = None) -> str:
    """Nome único e determinístico: mesmo vídeo + intervalo + opções (+ decisão do rosto) → mesmo arquivo."""
    fields: dict[str, Any] = {"v": RENDER_VERSION, "src": fingerprint, "s": spec.start, "e": spec.end, "f": spec.framing, "c": spec.captions}
    if spec.framing == "face":
        fields.update(fv=FACE_VERSION, x=round(offset, 4), m=effective or "face")
    key = json.dumps(fields, sort_keys=True)
    return f"{spec.clip_id}-{hashlib.sha256(key.encode()).hexdigest()[:10]}.mp4"


# ---------------------------------------------------------------------------
# Filtros de vídeo


@dataclass(frozen=True)
class OutputPlan:
    width: int
    height: int
    upscale: float | None  # ampliação da imagem da fonte (None = tamanho da fonte desconhecido)
    note: str


def output_plan(src_w: int | None, src_h: int | None, framing: str) -> OutputPlan:
    """Tamanho da saída 9:16 conforme a resolução da fonte (mesma regra de src/lib/render.ts)."""
    if not src_w or not src_h or src_w <= 0 or src_h <= 0:
        return OutputPlan(OUT_W, OUT_H, None, "")
    if framing == "blur":
        # Imagem inteira em primeiro plano, encaixada na largura (ou altura) da tela.
        upscale = min(OUT_W / src_w, OUT_H / src_h)
        region = f"a imagem inteira ({src_w}×{src_h})"
    else:
        win_h = min(src_h, src_w * 16 / 9)  # altura da janela 9:16 dentro da fonte
        upscale = OUT_H / win_h
        region = f"o recorte 9:16 ({round(win_h * 9 / 16)}×{round(win_h)} px da fonte)"
    if upscale > MAX_UPSCALE:
        low = upscale * LOW_H / OUT_H
        return OutputPlan(LOW_W, LOW_H, round(low, 2), f"Fonte {src_w}×{src_h}: {region} foi ampliado {fmt_x(low)} para {LOW_W}×{LOW_H}. Saída menor para não ampliar demais; detalhes que não existem na fonte não são recuperados.")
    note = f"Fonte {src_w}×{src_h}: {region} foi ampliado {fmt_x(upscale)}." if upscale > NOTE_UPSCALE else ""
    return OutputPlan(OUT_W, OUT_H, round(upscale, 2), note)


def fmt_x(value: float) -> str:
    return f"{value:.1f}".replace(".", ",") + "×"


def video_filter(framing: str, with_captions: bool, offset: float = 0.5, size: tuple[int, int] = (OUT_W, OUT_H)) -> str:
    """Grafo de filtros [0:v] → [v] (valores fixos; nada vem do usuário).

    `offset` (só em "face"): posição horizontal fixa da janela, de 0 (esquerda) a 1 (direita).
    """
    w, h = size
    if (w, h) not in ((OUT_W, OUT_H), (LOW_W, LOW_H)):
        raise RenderError(f"Tamanho de saída inválido: {w}×{h}.")
    if framing == "crop":
        graph = f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1"
    elif framing == "face":
        x = min(1.0, max(0.0, float(offset)))
        graph = f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}:x=(iw-ow)*{x:.4f}:y=(ih-oh)/2,setsar=1"
    elif framing == "blur":
        # Fundo desfocado em baixa resolução (rápido) e depois ampliado.
        graph = (
            "[0:v]split=2[bgsrc][fgsrc];"
            "[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,"
            "boxblur=luma_radius=12:luma_power=2,eq=brightness=-0.08,"
            f"scale={w}:{h}:flags=bicubic,setsar=1[bg];"
            f"[fgsrc]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2"
        )
    else:
        raise RenderError(f"Enquadramento inválido: {framing!r}.")
    if with_captions:
        graph += ",subtitles=captions.ass"  # caminho relativo: o FFmpeg roda na pasta temporária
    return graph + ",format=yuv420p[v]"


def build_command(
    settings: Settings, source: Path, spec: RenderSpec, out_file: str, with_captions: bool, gain_db: float = 0.0, offset: float = 0.5,
    framing: str | None = None, size: tuple[int, int] = (OUT_W, OUT_H),
) -> list[str]:
    """`framing`: enquadramento efetivo (o modo "face" pode decidir por "blur")."""
    graph = video_filter(framing or spec.framing, with_captions, offset, size) + ";" + audio_filter(gain_db, spec.duration)
    return [
        settings.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{spec.start:.3f}", "-i", str(source), "-t", f"{spec.duration:.3f}",
        "-filter_complex", graph,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", settings.render_preset, "-crf", str(settings.render_crf),
        "-profile:v", "high", "-pix_fmt", "yuv420p", "-fpsmax", "60",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats",
        out_file,
    ]  # fmt: skip


# ---------------------------------------------------------------------------
# Legendas (ASS)


@dataclass
class Word:
    text: str
    start: float
    end: float


def clip_words(segments: list[dict[str, Any]], start: float, end: float) -> list[Word]:
    """Palavras dentro do corte, com tempos relativos ao início do corte."""
    words: list[Word] = []
    dur = end - start
    for seg in segments:
        s_start, s_end = float(seg.get("startSec", 0)), float(seg.get("endSec", 0))
        if s_end <= start or s_start >= end:
            continue
        seg_words = seg.get("words")
        if not seg_words:  # sem tempos por palavra: distribui o texto do trecho igualmente
            tokens = str(seg.get("text", "")).split()
            step = (s_end - s_start) / max(1, len(tokens))
            seg_words = [{"word": t, "startSec": s_start + i * step, "endSec": s_start + (i + 1) * step} for i, t in enumerate(tokens)]
        for w in seg_words:
            w_start, w_end = float(w.get("startSec", 0)), float(w.get("endSec", 0))
            mid = (w_start + w_end) / 2
            text = str(w.get("word", "")).strip()
            if text and start <= mid < end:
                words.append(Word(text, max(0.0, w_start - start), min(dur, max(w_end, w_start + 0.05) - start)))
    return words


def ass_escape(text: str) -> str:
    """Neutraliza blocos de formatação e quebras: o texto aparece literalmente."""
    text = " ".join(text.split())
    return text.replace("\\", "/").replace("{", "(").replace("}", ")")


def ass_time(seconds: float) -> str:
    cs = max(0, int(round(seconds * 100)))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


@dataclass(frozen=True)
class CaptionLayout:
    max_words: int  # palavras por legenda
    line_chars: int  # caracteres por linha (cabe na largura útil de 900 px com a fonte do estilo)
    max_lines: int
    clause_words: int  # vírgula fecha a legenda a partir de quantas palavras


LAYOUTS = {
    "classic": CaptionLayout(max_words=8, line_chars=24, max_lines=2, clause_words=3),
    "keywords": CaptionLayout(max_words=8, line_chars=24, max_lines=2, clause_words=3),
    "highlight": CaptionLayout(max_words=3, line_chars=14, max_lines=2, clause_words=2),
}
PAUSE_BREAK_SEC = 0.6  # silêncio que fecha a legenda (não mostra texto de frases separadas juntos)
MIN_CAPTION_SEC = 0.7  # tempo mínimo de leitura, se a próxima legenda não começar antes
# Palavras que não devem terminar uma linha nem uma legenda ("de", "o", "que"…): ficam com a seguinte.
WEAK_END = set("a o as os um uma uns umas de da do das dos em na no nas nos e ou que se ao aos para pra pro com por sem mas como".split())


def _plain(text: str) -> str:
    return re.sub(r"[^\w]", "", norm(text))


def _chunks(words: list[Word], layout: CaptionLayout) -> list[list[Word]]:
    """Agrupa as palavras em legendas curtas, fechando em pontuação e pausas."""
    chunks: list[list[Word]] = []
    current: list[Word] = []
    limit = layout.line_chars * layout.max_lines

    def close() -> None:
        nonlocal current
        if current:
            chunks.append(current)
            current = []

    for w in words:
        gap = w.start - current[-1].end if current else 0.0
        length = sum(len(x.text) + 1 for x in current) + len(w.text)
        if current and (len(current) >= layout.max_words or length > limit or gap > PAUSE_BREAK_SEC):
            # Não deixa "de", "que"… no fim da legenda: as palavras fracas passam para a próxima.
            carry: list[Word] = []
            while gap <= PAUSE_BREAK_SEC and len(current) > 1 and _plain(current[-1].text) in WEAK_END:
                carry.insert(0, current.pop())
            close()
            current.extend(carry)
        current.append(w)
        if w.text[-1:] in ".?!…":
            close()
        elif w.text[-1:] in ",;:" and len(current) >= layout.clause_words:
            close()
    close()
    return chunks


def _line_break(texts: list[str], layout: CaptionLayout) -> int | None:
    """Índice da primeira palavra da 2ª linha (None = cabe numa linha). Linhas equilibradas."""
    total = sum(len(t) for t in texts) + len(texts) - 1
    if total <= layout.line_chars or len(texts) < 2:
        return None

    def cost(i: int) -> float:
        top = sum(len(t) for t in texts[:i]) + i - 1
        bottom = total - top - 1
        penalty = 8 if _plain(texts[i - 1]) in WEAK_END else 0  # linha terminando em "de", "que"…
        penalty -= 3 if texts[i - 1][-1:] in ",;:" else 0  # quebra natural na vírgula
        return max(top, bottom) + penalty + (1 if top > bottom else 0)  # em empate, linha de cima menor

    return min(range(1, len(texts)), key=cost)


def _join_lines(parts: list[str], split: int | None) -> str:
    if split is None:
        return " ".join(parts)
    return " ".join(parts[:split]) + "\\N" + " ".join(parts[split:])


def _chunk_end(chunk: list[Word], following: list[Word] | None, dur: float) -> float:
    end = max(chunk[-1].end, chunk[0].start + MIN_CAPTION_SEC)
    if following:
        if following[0].start - chunk[-1].end < 0.3:  # evita piscar entre frases próximas
            end = following[0].start
        end = min(end, following[0].start)  # nunca sobrepõe a próxima legenda
    return min(end, dur)


# Números e quantidades chamam atenção na tela; palavras do título e das tags
# são o assunto do corte.
NUMBER_WORDS = set("mil milhao milhoes bilhao bilhoes cem cento dobro metade triplo".split())
KEYWORD_REPEAT_GAP = 3  # a mesma palavra-chave só volta a ser destacada depois de 3 legendas


def keyword_stems(title: str, tags: list[str]) -> set[str]:
    return {w[:6] for w in norm_words(" ".join([title, *tags])) if len(w) >= 4 and w not in STOPWORDS}


def _keyword_score(text: str, stems: set[str]) -> int:
    plain = _plain(text)
    if not plain:
        return 0
    if any(c.isdigit() for c in plain) or plain in NUMBER_WORDS or "$" in text or "%" in text:
        return 3
    if len(plain) >= 4 and plain not in STOPWORDS and plain[:6] in stems:
        return 2
    return 0


def pick_keywords(chunks: list[list[Word]], stems: set[str]) -> list[int | None]:
    """No máximo uma palavra destacada por legenda, e só se for número ou assunto do corte."""
    picks: list[int | None] = []
    last_seen: dict[str, int] = {}
    for n, chunk in enumerate(chunks):
        best, best_score = None, 1
        for i, w in enumerate(chunk):
            score = _keyword_score(w.text, stems)
            key = _plain(w.text)[:6]
            if score > best_score and n - last_seen.get(key, -99) > KEYWORD_REPEAT_GAP:
                best, best_score = i, score
        if best is not None:
            last_seen[_plain(chunk[best].text)[:6]] = n
        picks.append(best)
    return picks


HIGHLIGHT_COLOUR = "&H0000E5FF&"  # amarelo (ASS usa BGR)
WHITE = "&H00FFFFFF&"

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: classic,Arial,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,90,90,300,1
Style: highlight,Arial Black,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,7,0,2,70,70,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _colour(text: str) -> str:
    return f"{{\\c{HIGHLIGHT_COLOUR}}}{text}{{\\c{WHITE}}}"


def build_ass(words: list[Word], style: str, dur: float, keywords: set[str] | None = None) -> str:
    if style not in LAYOUTS:
        raise RenderError(f"Estilo de legenda inválido: {style!r}.")
    layout = LAYOUTS[style]
    lines = [ASS_HEADER.format(w=OUT_W, h=OUT_H)]
    chunks = _chunks(words, layout)
    picks = pick_keywords(chunks, keywords or set()) if style == "keywords" else [None] * len(chunks)
    ass_style = "highlight" if style == "highlight" else "classic"
    for i, chunk in enumerate(chunks):
        chunk_end = _chunk_end(chunk, chunks[i + 1] if i + 1 < len(chunks) else None, dur)
        texts = [ass_escape(w.text.upper() if style == "highlight" else w.text) for w in chunk]
        split = _line_break(texts, layout)
        if style == "highlight":
            # Uma linha de evento por palavra: a palavra falada fica amarela.
            for j, word in enumerate(chunk):
                start = word.start if j else chunk[0].start
                end = chunk[j + 1].start if j + 1 < len(chunk) else chunk_end
                if end > start:
                    parts = [_colour(t) if k == j else t for k, t in enumerate(texts)]
                    lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{ass_style},,0,0,0,,{_join_lines(parts, split)}\n")
        else:
            start = chunk[0].start
            if chunk_end > start:
                parts = [_colour(t) if k == picks[i] else t for k, t in enumerate(texts)]
                lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(chunk_end)},{ass_style},,0,0,0,,{_join_lines(parts, split)}\n")
    return "".join(lines)


# ---------------------------------------------------------------------------
# Áudio: volume uniforme sem compressão

TARGET_LUFS = -14.0  # referência comum de YouTube, Instagram e TikTok
MAX_TRUE_PEAK_DB = -1.0
MAX_GAIN_DB = 12.0
FADE_SEC = 0.02  # evita estalos nos pontos de corte


def loudness_gain_db(integrated: float | None, true_peak: float | None) -> float:
    """Ganho linear (um só valor para o corte inteiro) que aproxima o volume de -14 LUFS.

    Sem compressor nem limitador: a dinâmica natural da voz é preservada. O
    ganho nunca leva o pico acima de -1 dBTP, então o áudio não distorce;
    se o pico já está alto, o volume sobe menos do que o alvo.
    """
    if integrated is None or true_peak is None or not math.isfinite(integrated) or integrated < -70:
        return 0.0  # silêncio ou medição impossível: não mexe
    gain = TARGET_LUFS - integrated
    if math.isfinite(true_peak):
        gain = min(gain, MAX_TRUE_PEAK_DB - true_peak)
    return round(max(-MAX_GAIN_DB, min(MAX_GAIN_DB, gain)), 2)


def measure_loudness(settings: Settings, source: Path, spec: RenderSpec) -> tuple[float | None, float | None]:
    """Volume integrado (LUFS) e pico real (dBTP) do trecho, medidos pelo filtro loudnorm."""
    cmd = [
        settings.ffmpeg, "-nostdin", "-hide_banner", "-nostats",
        "-ss", f"{spec.start:.3f}", "-i", str(source), "-t", f"{spec.duration:.3f}",
        "-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-",
    ]  # fmt: skip
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=max(120.0, spec.duration * 5))
    except (OSError, subprocess.SubprocessError):
        return None, None
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", out.stderr or "")
    if out.returncode != 0 or not match:
        return None, None
    try:
        data = json.loads(match.group(0))
        return float(data["input_i"]), float(data["input_tp"])
    except (ValueError, KeyError):
        return None, None


def audio_filter(gain_db: float, duration: float) -> str:
    fade_out = max(0.0, duration - FADE_SEC)
    return f"[0:a:0]volume={gain_db:.2f}dB,afade=t=in:st=0:d={FADE_SEC},afade=t=out:st={fade_out:.3f}:d={FADE_SEC}[a]"


# ---------------------------------------------------------------------------
# Execução e verificação


def probe(settings: Settings, path: Path) -> dict[str, Any]:
    try:
        out = subprocess.run(
            [settings.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError) as err:
        raise RenderError(f"ffprobe indisponível: {err}") from None
    if out.returncode != 0:
        raise RenderError("O arquivo gerado não pôde ser lido pelo ffprobe.")
    return json.loads(out.stdout or "{}")


def verify_output(settings: Settings, path: Path, expected: float, size: tuple[int, int] = (OUT_W, OUT_H)) -> float:
    """Confere H.264 no tamanho planejado, yuv420p + AAC e a duração. Retorna a duração real."""
    info = probe(settings, path)
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video or video.get("codec_name") != "h264" or (video.get("width"), video.get("height")) != size or video.get("pix_fmt") != "yuv420p":
        raise RenderError(f"O vídeo gerado não está em H.264 {size[0]}×{size[1]}.")
    if not audio or audio.get("codec_name") != "aac":
        raise RenderError("O vídeo gerado ficou sem áudio AAC.")
    duration = float((info.get("format") or {}).get("duration") or 0)
    if abs(duration - expected) > max(0.4, expected * 0.02):
        raise RenderError(f"Duração gerada ({duration:.2f}s) diferente da esperada ({expected:.2f}s).")
    return duration


def run_ffmpeg(cmd: list[str], cwd: Path, duration: float, on_progress: Callable[[float], None]) -> None:
    """Executa o FFmpeg (sem shell), lendo o progresso. `on_progress` pode lançar para cancelar."""
    timeout = max(300.0, duration * 30)
    started = time.monotonic()
    err_path = cwd / "ffmpeg-stderr.txt"
    try:
        with open(err_path, "w", encoding="utf-8") as err_file:
            proc = subprocess.Popen(cmd, cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err_file, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise RenderError(f"FFmpeg não encontrado ({cmd[0]!r}). Instale-o ou defina FFMPEG_PATH.") from None
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                value = line.split("=", 1)[1].strip()
                if value.lstrip("-").isdigit():
                    on_progress(min(1.0, max(0.0, int(value) / 1e6 / duration)))
            if time.monotonic() - started > timeout:
                raise RenderError(f"A renderização passou de {int(timeout)} s e foi interrompida.")
        code = proc.wait(timeout=60)
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        if proc.stdout:
            proc.stdout.close()
    if code != 0:
        detail = err_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()
        raise RenderError("O FFmpeg falhou: " + (" | ".join(detail[-3:])[:300] or f"código {code}"))


# ---------------------------------------------------------------------------
# Etapa


class RenderStage:
    def __init__(self, settings: Settings, api: WorkerApi, detector: FaceDetector | None = None):
        self.settings = settings
        self.api = api
        self.detector = detector or YuNetDetector(settings.face_model)
        self._video_size: tuple[int, int] | None = None
        self._framing_note = ""
        self._quality_note = ""

    def process(self, job: dict[str, Any]) -> JobOutcome:
        project_id = str(job.get("projectId") or "?")
        clips = [c for c in job.get("clips") or [] if isinstance(c, dict)]
        pending = [c for c in clips if (c.get("render") or {}).get("state") in ("queued", "running")]
        already_done = sum(1 for c in clips if (c.get("render") or {}).get("state") == "done")

        try:
            source = resolve_source(self.settings, job)
            if not source.is_file():
                raise UnsafeJob("o vídeo original não está na pasta de dados")
        except UnsafeJob as err:
            return self._finish(project_id, done=already_done, failed=len(pending), first_error=f"Arquivo de mídia inválido: {err}.")

        try:
            self.api.progress(project_id, 0.01, f"Preparando {len(pending)} corte(s)")
        except JobGone as err:
            return JobOutcome(project_id, "skipped", str(err))

        transcript = self._load_transcript(source)
        fingerprint = source_fingerprint(source)
        self._video_size = self._probe_size(source)
        renders = source.parent / RENDERS_DIR
        renders.mkdir(exist_ok=True)
        media_duration = (job.get("media") or {}).get("durationSec")
        done, failed, first_error = already_done, 0, ""

        for index, clip in enumerate(pending):
            clip_id = str(clip.get("id"))
            try:
                ok, error = self._render_clip(project_id, clip, index, len(pending), source, renders, fingerprint, transcript, media_duration)
            except (JobGone, RenderCancelled) as err:
                log.info("Projeto %s mudou durante a renderização (%s); cancelado.", project_id, err)
                return JobOutcome(project_id, "cancelled", str(err))
            except AppUnreachable as err:
                log.warning("Projeto %s: a aplicação parou de responder (%s). Será retomado.", project_id, err)
                return JobOutcome(project_id, "interrupted", str(err))
            if ok:
                done += 1
            else:
                failed += 1
                first_error = first_error or f"{clip_id}: {error}"
        return self._finish(project_id, done=done, failed=failed, first_error=first_error)

    def _load_transcript(self, source: Path) -> list[dict[str, Any]] | None:
        try:
            data = json.loads((source.parent / TRANSCRIPT_FILE).read_text(encoding="utf-8"))
            segments = data.get("segments")
            return segments if isinstance(segments, list) else None
        except (OSError, ValueError):
            return None

    def _render_clip(self, project_id: str, clip: dict[str, Any], index: int, total: int, source: Path, renders: Path,
                     fingerprint: dict[str, Any], transcript: list[dict[str, Any]] | None, media_duration: float | None) -> tuple[bool, str]:  # fmt: skip
        clip_id = str(clip.get("id"))
        last_sent = 0.0

        def report(fraction: float, force: bool = False) -> None:
            nonlocal last_sent
            now = time.monotonic()
            if not force and now - last_sent < PROGRESS_INTERVAL_SEC:
                return
            last_sent = now
            self.api.clip_render(project_id, clip_id, "running", progress=round(fraction, 3))
            self.api.progress(project_id, min(0.99, (index + fraction) / total), f"Renderizando corte {index + 1} de {total}")

        try:
            spec = validate_clip(clip, media_duration)
        except RenderError as err:
            return self._clip_failed(project_id, clip_id, str(err))

        report(0.0, force=True)
        decision = FramingDecision("center", 0.5, "")
        if spec.framing == "face":
            if self._video_size:
                decision = analyze(self.detector, self.settings.ffmpeg, source, spec.start, spec.duration, *self._video_size)
            else:
                decision = FramingDecision("center", 0.5, "Tamanho do vídeo desconhecido: recorte central.")
            log.info("Projeto %s: %s — %s", project_id, clip_id, decision.note)
        effective = "blur" if decision.mode == "blur" else spec.framing
        plan = output_plan(*(self._video_size or (None, None)), effective)
        size = (plan.width, plan.height)
        self._framing_note = decision.note
        self._quality_note = plan.note
        name = output_name(spec, fingerprint, decision.offset, effective)
        final = renders / name

        if final.is_file():
            try:
                duration = verify_output(self.settings, final, spec.duration, size)
                log.info("Projeto %s: %s já renderizado (%s); reaproveitando.", project_id, clip_id, name)
                return self._clip_done(project_id, clip_id, final, duration)
            except RenderError:
                log.info("Projeto %s: arquivo anterior de %s inválido; renderizando de novo.", project_id, clip_id)

        with_captions = spec.captions != "none"
        if with_captions and transcript is None:
            return self._clip_failed(project_id, clip_id, "A transcrição não foi encontrada para gerar as legendas. Use “Sem legenda” ou transcreva de novo.")

        workdir = Path(tempfile.mkdtemp(prefix=f"{project_id}-render-", dir=work_root(self.settings)))
        try:
            if with_captions:
                words = clip_words(transcript or [], spec.start, spec.end)
                tags = [str(t) for t in clip.get("tags") or [] if isinstance(t, str)][:8]
                stems = keyword_stems(str(clip.get("title") or "")[:200], tags)
                (workdir / "captions.ass").write_text(build_ass(words, spec.captions, spec.duration, stems), encoding="utf-8")
            started = time.monotonic()
            integrated, peak = measure_loudness(self.settings, source, spec)
            gain = loudness_gain_db(integrated, peak)
            log.info(
                "Projeto %s: renderizando %s (%.1f–%.1fs, %s, legenda %s, volume %s LUFS → ganho %+.1f dB).",
                project_id, clip_id, spec.start, spec.end, spec.framing, spec.captions, f"{integrated:.1f}" if integrated is not None else "?", gain,
            )  # fmt: skip
            cmd = build_command(self.settings, source, spec, "out.mp4", with_captions, gain, decision.offset, effective, size)
            run_ffmpeg(cmd, workdir, spec.duration, report)
            duration = verify_output(self.settings, workdir / "out.mp4", spec.duration, size)
            os.replace(workdir / "out.mp4", final)
            log.info("Projeto %s: %s pronto em %.0f s → %s/%s", project_id, clip_id, time.monotonic() - started, RENDERS_DIR, name)
            return self._clip_done(project_id, clip_id, final, duration)
        except RenderError as err:
            return self._clip_failed(project_id, clip_id, str(err))
        except OSError as err:
            return self._clip_failed(project_id, clip_id, f"Erro de arquivo: {err.strerror or err}.")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _clip_done(self, project_id: str, clip_id: str, final: Path, duration: float) -> tuple[bool, str]:
        extra = {k: v[:200] for k, v in (("framingNote", self._framing_note), ("qualityNote", self._quality_note)) if v}
        self.api.clip_render(project_id, clip_id, "done", file=f"{RENDERS_DIR}/{final.name}", sizeBytes=final.stat().st_size, durationSec=round(duration, 3), **extra)
        return True, ""

    def _probe_size(self, source: Path) -> tuple[int, int] | None:
        """Largura e altura de exibição do vídeo (considera vídeos gravados girados)."""
        try:
            video = next(s for s in probe(self.settings, source).get("streams") or [] if s.get("codec_type") == "video")
            w, h = int(video["width"]), int(video["height"])
            rotation = abs(int(float((video.get("tags") or {}).get("rotate") or 0)))
            if rotation in (90, 270):
                w, h = h, w
            return (w, h) if w > 0 and h > 0 else None
        except (RenderError, StopIteration, KeyError, TypeError, ValueError):
            return None

    def _clip_failed(self, project_id: str, clip_id: str, message: str) -> tuple[bool, str]:
        log.error("Projeto %s: corte %s falhou: %s", project_id, clip_id, message)
        self.api.clip_render(project_id, clip_id, "failed", error=message)
        return False, message

    def _finish(self, project_id: str, *, done: int, failed: int, first_error: str) -> JobOutcome:
        try:
            if done > 0:
                note = f"{done} corte(s) renderizado(s)" + (f"; {failed} com falha" if failed else "")
                self.api.transition(project_id, "completed", note=note)
                log.info("Projeto %s → concluído. %s", project_id, note)
                return JobOutcome(project_id, "completed", note)
            message = f"Nenhum corte foi renderizado. {first_error}".strip()
            self.api.transition(project_id, "failed", error={"stage": "render", "message": message})
            log.error("Projeto %s falhou na renderização: %s", project_id, message)
            return JobOutcome(project_id, "failed", message)
        except JobGone as err:
            return JobOutcome(project_id, "cancelled", str(err))
        except AppUnreachable as err:
            return JobOutcome(project_id, "interrupted", str(err))
