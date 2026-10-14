"""Extração de áudio com o FFmpeg local."""

from __future__ import annotations

import subprocess
from pathlib import Path


class AudioError(Exception):
    pass


def ffmpeg_version(ffmpeg: str = "ffmpeg") -> str | None:
    try:
        out = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=15, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    first = out.stdout.splitlines()[0] if out.stdout else ""
    return first.replace("ffmpeg version ", "").split(" Copyright")[0] or "?"


def extract_audio(source: Path, dest: Path, *, ffmpeg: str = "ffmpeg", duration_sec: float | None = None) -> None:
    """Converte a primeira faixa de áudio para WAV mono 16 kHz (o formato do Whisper).

    - Argumentos em lista, sem shell: nomes de arquivo nunca são interpretados.
    - `-nostdin` impede o FFmpeg de esperar entrada do teclado.
    - Tempo limite proporcional à duração, para um arquivo defeituoso não travar o worker.
    """
    timeout = max(120.0, (duration_sec or 0) * 0.5)
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav",
        str(dest),
    ]  # fmt: skip
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError:
        raise AudioError(f"FFmpeg não encontrado ({ffmpeg!r}). Instale-o ou defina FFMPEG_PATH.") from None
    except subprocess.TimeoutExpired:
        raise AudioError(f"A extração de áudio passou de {int(timeout)} s e foi interrompida.") from None
    if result.returncode != 0:
        stderr = result.stderr or ""
        if "'0:a:0'" in stderr or "matches no streams" in stderr:
            raise AudioError("O vídeo não tem faixa de áudio para transcrever.")
        detail = stderr.strip().splitlines()
        tail = " | ".join(detail[-3:])[:300] or f"código {result.returncode}"
        raise AudioError(f"O FFmpeg não conseguiu extrair o áudio: {tail}")
    if not dest.is_file() or dest.stat().st_size <= 44:  # 44 bytes = só o cabeçalho WAV
        raise AudioError("O FFmpeg não gerou áudio: o arquivo parece não ter som utilizável.")
