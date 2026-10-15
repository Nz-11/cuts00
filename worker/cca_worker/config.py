"""Configuração do worker.

Lê, nesta ordem de prioridade:
  1. variáveis de ambiente do processo;
  2. `.env.local` da aplicação (o mesmo arquivo usado pelo `npm run dev`);
  3. `.env` da aplicação;
  4. valores padrão abaixo.

O token nunca é impresso: `Settings.__repr__` o omite.
"""

from __future__ import annotations

import os
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent
APP_DIR = WORKER_DIR.parent

DEFAULT_APP_URL = "http://localhost:3000"
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
RENDER_PRESETS = ("ultrafast", "superfast", "veryfast", "faster", "fast", "medium")
WHISPER_MODELS = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")


def parse_env_file(text: str) -> dict[str, str]:
    """Interpreta um arquivo .env simples (CHAVE=valor, comentários com #)."""
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            comment = value.find(" #")
            if comment != -1:
                value = value[:comment].rstrip()
        values[key] = value
    return values


def load_env(app_dir: Path = APP_DIR, environ: dict[str, str] | None = None) -> dict[str, str]:
    """Combina .env, .env.local e o ambiente do processo (este vence)."""
    merged: dict[str, str] = {}
    for name in (".env", ".env.local"):
        path = app_dir / name
        if path.is_file():
            merged.update(parse_env_file(path.read_text(encoding="utf-8-sig")))
    merged.update({k: v for k, v in (os.environ if environ is None else environ).items()})
    return {k: v for k, v in merged.items() if v != ""}


def _int(env: dict[str, str], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = env.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} deve ser um número inteiro (recebido: {raw!r}).") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} deve estar entre {minimum} e {maximum} (recebido: {value}).")
    return value


def _path(raw: str | None, default: Path) -> Path:
    if not raw:
        return default
    path = Path(raw)
    return (path if path.is_absolute() else WORKER_DIR / path).resolve()


def default_cpu_threads() -> int:
    """Núcleos físicos aproximados: metade dos lógicos (Hyper-Threading), no mínimo 1."""
    return max(1, (os.cpu_count() or 2) // 2)


@dataclass(frozen=True)
class Settings:
    app_url: str
    token: str | None = field(repr=False)
    data_dir: Path
    ffmpeg: str
    model: str
    language: str | None
    device: str
    compute_type: str
    cpu_threads: int
    beam_size: int
    models_dir: Path
    poll_seconds: int
    # Seleção de cortes (Ollama local)
    ollama_url: str = DEFAULT_OLLAMA_URL
    select_model: str = "qwen2.5:7b"
    select_num_ctx: int = 8192
    clip_min_sec: int = 15
    clip_max_sec: int = 90
    max_clips: int = 10
    window_sec: int = 480
    window_overlap_sec: int = 60
    # Renderização (FFmpeg local)
    ffprobe: str = "ffprobe"
    render_preset: str = "veryfast"
    render_crf: int = 20
    face_model: Path = WORKER_DIR / "models" / "yunet" / "face_detection_yunet_2026may.onnx"
    env_files: tuple[str, ...] = ()

    @property
    def token_defined(self) -> bool:
        return bool(self.token)

    @property
    def model_path(self) -> Path:
        return self.models_dir / self.model


def load_settings(app_dir: Path = APP_DIR, environ: dict[str, str] | None = None) -> Settings:
    env = load_env(app_dir, environ)

    app_url = env.get("CCA_APP_URL", DEFAULT_APP_URL).rstrip("/")
    if not app_url.startswith(("http://", "https://")):
        raise ValueError(f"CCA_APP_URL deve começar com http:// ou https:// (recebido: {app_url!r}).")

    data_dir = Path(env.get("CCA_DATA_DIR", ".data"))
    if not data_dir.is_absolute():
        data_dir = app_dir / data_dir  # o Next resolve relativo à pasta da aplicação

    models_dir = Path(env.get("CCA_WHISPER_MODELS_DIR", str(WORKER_DIR / "models")))
    if not models_dir.is_absolute():
        models_dir = WORKER_DIR / models_dir

    model = env.get("CCA_WHISPER_MODEL", "small")
    if model not in WHISPER_MODELS:
        raise ValueError(f"CCA_WHISPER_MODEL inválido: {model!r}. Use um de: {', '.join(WHISPER_MODELS)}.")

    language = env.get("CCA_WHISPER_LANGUAGE", "pt").lower()
    if language == "auto":
        language_value: str | None = None
    elif language.isalpha() and 2 <= len(language) <= 3:
        language_value = language
    else:
        raise ValueError(f"CCA_WHISPER_LANGUAGE inválido: {language!r}. Use um código como pt, en, es ou auto.")

    device = env.get("CCA_WHISPER_DEVICE", "cpu")
    if device not in ("cpu", "cuda", "auto"):
        raise ValueError(f"CCA_WHISPER_DEVICE deve ser cpu, cuda ou auto (recebido: {device!r}).")

    ollama_url = env.get("CCA_OLLAMA_URL", DEFAULT_OLLAMA_URL).rstrip("/")
    parsed = urllib.parse.urlparse(ollama_url)
    if parsed.scheme != "http" or (parsed.hostname or "") not in LOOPBACK_HOSTS:
        # A transcrição nunca sai deste computador: só Ollama local é aceito.
        raise ValueError(f"CCA_OLLAMA_URL precisa apontar para este computador (http://127.0.0.1:11434). Recebido: {ollama_url!r}.")

    select_model = env.get("CCA_SELECT_MODEL", "qwen2.5:7b")
    if not select_model or any(c.isspace() for c in select_model) or len(select_model) > 100:
        raise ValueError(f"CCA_SELECT_MODEL inválido: {select_model!r}.")

    clip_min = _int(env, "CCA_CLIP_MIN_SEC", 15, 5, 600)
    clip_max = _int(env, "CCA_CLIP_MAX_SEC", 90, 10, 900)
    if clip_max <= clip_min:
        raise ValueError(f"CCA_CLIP_MAX_SEC ({clip_max}) deve ser maior que CCA_CLIP_MIN_SEC ({clip_min}).")
    window = _int(env, "CCA_SELECT_WINDOW_SEC", 480, 120, 3600)
    overlap = _int(env, "CCA_SELECT_OVERLAP_SEC", 60, 0, 600)
    if overlap >= window or window < clip_max * 2:
        raise ValueError("CCA_SELECT_WINDOW_SEC deve ser maior que a sobreposição e ter pelo menos o dobro de CCA_CLIP_MAX_SEC.")

    render_preset = env.get("CCA_RENDER_PRESET", "veryfast")
    if render_preset not in RENDER_PRESETS:
        raise ValueError(f"CCA_RENDER_PRESET inválido: {render_preset!r}. Use um de: {', '.join(RENDER_PRESETS)}.")

    return Settings(
        app_url=app_url,
        token=env.get("CCA_WORKER_TOKEN"),
        data_dir=data_dir.resolve(),
        ffmpeg=env.get("FFMPEG_PATH", "ffmpeg"),
        model=model,
        language=language_value,
        device=device,
        compute_type=env.get("CCA_WHISPER_COMPUTE", "int8"),
        cpu_threads=_int(env, "CCA_WHISPER_THREADS", default_cpu_threads(), 1, 64),
        beam_size=_int(env, "CCA_WHISPER_BEAM", 5, 1, 10),
        models_dir=models_dir.resolve(),
        poll_seconds=_int(env, "CCA_WORKER_POLL_SECONDS", 5, 1, 3600),
        ollama_url=ollama_url,
        select_model=select_model,
        select_num_ctx=_int(env, "CCA_SELECT_NUM_CTX", 8192, 2048, 32768),
        clip_min_sec=clip_min,
        clip_max_sec=clip_max,
        max_clips=_int(env, "CCA_SELECT_MAX_CLIPS", 10, 1, 50),
        window_sec=window,
        window_overlap_sec=overlap,
        ffprobe=env.get("FFPROBE_PATH", "ffprobe"),
        render_preset=render_preset,
        render_crf=_int(env, "CCA_RENDER_CRF", 20, 14, 32),
        face_model=_path(env.get("CCA_FACE_MODEL"), WORKER_DIR / "models" / "yunet" / "face_detection_yunet_2026may.onnx"),
        env_files=tuple(name for name in (".env", ".env.local") if (app_dir / name).is_file()),
    )
