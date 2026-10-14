"""Transcrição local com faster-whisper (CPU por padrão, int8 para economizar memória).

O modelo fica em `worker/models/<nome>` e só é baixado pelo comando explícito
`python -m cca_worker download-model`; o worker nunca baixa nada sozinho.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

from .config import Settings

# progress(segundos_transcritos, duracao_total). Pode lançar exceção para interromper.
ProgressFn = Callable[[float, float], None]


class ModelMissing(Exception):
    pass


@dataclass
class TranscriptResult:
    language: str
    language_probability: float
    duration_sec: float
    segments: list[dict[str, Any]] = field(default_factory=list)

    @property
    def word_count(self) -> int:
        return sum(len(s.get("words") or []) for s in self.segments)


class Transcriber(Protocol):
    name: str

    def transcribe(self, audio: Path, on_progress: ProgressFn) -> TranscriptResult: ...


def model_is_downloaded(path: Path) -> bool:
    return (path / "model.bin").is_file() and (path / "config.json").is_file()


def download_model(settings: Settings) -> Path:
    from faster_whisper.utils import download_model as fw_download

    settings.models_dir.mkdir(parents=True, exist_ok=True)
    fw_download(settings.model, output_dir=str(settings.model_path))
    return settings.model_path


class WhisperTranscriber:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.name = settings.model
        self._model = None

    def load(self) -> None:
        if self._model is not None:
            return
        path = self.settings.model_path
        if not model_is_downloaded(path):
            raise ModelMissing(
                f"O modelo Whisper '{self.settings.model}' não está em {path}. "
                f"Baixe-o uma vez com: worker\\start.cmd download-model"
            )
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            str(path),
            device=self.settings.device,
            compute_type=self.settings.compute_type,
            cpu_threads=self.settings.cpu_threads,
            num_workers=1,
            local_files_only=True,
        )

    def transcribe(self, audio: Path, on_progress: ProgressFn) -> TranscriptResult:
        self.load()
        assert self._model is not None
        segments_iter, info = self._model.transcribe(
            load_wav_16k_mono(audio),
            language=self.settings.language,
            task="transcribe",
            beam_size=self.settings.beam_size,
            word_timestamps=True,
            vad_filter=True,  # pula silêncios longos: mais rápido e menos "alucinação"
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,  # evita repetições em vídeos longos
        )
        total = float(info.duration or 0.0)
        segments: list[dict[str, Any]] = []
        for seg in segments_iter:  # o gerador transcreve sob demanda
            item = segment_to_dict(len(segments), seg)
            if item is not None:
                segments.append(item)
            on_progress(float(seg.end), total)
        return TranscriptResult(
            language=info.language,
            language_probability=round(float(info.language_probability or 0.0), 4),
            duration_sec=round(total, 3),
            segments=segments,
        )


SAMPLE_RATE = 16000


def load_wav_16k_mono(path: Path):
    """Lê o WAV gerado pelo FFmpeg (PCM 16 bits, mono, 16 kHz) como float32 em [-1, 1].

    O áudio é entregue ao modelo já decodificado: assim não dependemos do
    decodificador do PyAV, cuja API muda entre versões (o PyAV 19 quebrou
    o `decode_audio` do faster-whisper 1.2.1).
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as wav:
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, SAMPLE_RATE, 2):
            raise ValueError(f"WAV inesperado: {wav.getnchannels()} canais, {wav.getframerate()} Hz, {wav.getsampwidth() * 8} bits.")
        raw = wav.readframes(wav.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def segment_to_dict(index: int, seg: Any) -> dict[str, Any] | None:
    """Converte um segmento do faster-whisper no formato `TranscriptSegment` da aplicação."""
    text = (seg.text or "").strip()
    if not text:
        return None
    item: dict[str, Any] = {"id": index, "startSec": round(float(seg.start), 3), "endSec": round(float(seg.end), 3), "text": text}
    words = []
    for w in seg.words or []:
        token = (w.word or "").strip()
        if token:
            words.append({"word": token, "startSec": round(float(w.start), 3), "endSec": round(float(w.end), 3), "probability": round(float(w.probability), 3)})
    if words:
        item["words"] = words
    return item
