"""Enquadramento 9:16 pelo rosto: uma posição FIXA por corte, sem zoom e sem movimento.

Para cada corte com enquadramento "face":
  1. Extrai alguns quadros espaçados do trecho (FFmpeg, só leitura do original).
  2. Detecta rostos com o YuNet (modelo ONNX de ~230 KB, licença MIT, do
     repositório oficial opencv/opencv_zoo) no onnxruntime já instalado.
  3. Escolhe o rosto principal (o maior e mais presente) e calcula uma posição
     horizontal estável: a mediana das posições, que ignora quadros isolados.
  4. Se o rosto é pequeno (menos de 1/3 da altura), a pessoa é só parte da
     imagem: recortar esconderia o resto, então usa o fundo desfocado.
  5. Só usa a posição se a detecção for confiável. Senão, volta ao recorte
     central e registra o motivo:
       - rosto em menos de 60% dos quadros;
       - rosto que se desloca mais do que cabe numa janela fixa;
       - modelo ausente ou erro do detector.

A altura do vídeo é sempre mantida inteira (o recorte 9:16 de um vídeo
horizontal só corta as laterais), então rosto e parte superior do corpo
ficam na tela quando o rosto está dentro da janela escolhida.
"""

from __future__ import annotations

import logging
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger("cca_worker")

FACE_VERSION = 2  # muda o nome dos arquivos se a regra de escolha mudar (2: rosto pequeno → fundo desfocado)
TARGET_ASPECT = 9 / 16
SCORE_THRESHOLD = 0.7
NMS_IOU = 0.3
MIN_FACE_HEIGHT = 0.06  # rostos menores que 6% da altura (plateia, fundo) são ignorados
SECONDARY_AREA = 0.5  # rostos com pelo menos metade da área do principal contam como "também em cena"
MIN_PRESENCE = 0.6  # rosto principal em pelo menos 60% dos quadros
MIN_INSIDE = 0.9  # e dentro da janela fixa em pelo menos 90% deles (senão sairia de cena)
CENTER_DEADZONE = 0.03  # posição a menos de 3% do centro → usa o centro exato
# Rosto com menos de 1/3 da altura: a pessoa é só parte da imagem (câmera no canto de
# uma gravação de tela, plano aberto) e o recorte esconderia o resto. Medido num vídeo
# real: câmera sobre gravação de tela = 24–26% da altura; pessoa falando para a câmera = 46–59%.
SMALL_FACE_HEIGHT = 0.33
ANALYSIS_WIDTHS = (640, 320)  # 2ª passada menor para rostos muito grandes (close)


@dataclass(frozen=True)
class Face:
    """Rosto em coordenadas normalizadas (0–1) do quadro."""

    x: float
    y: float
    w: float
    h: float
    score: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def area(self) -> float:
        return self.w * self.h


@dataclass(frozen=True)
class FramingDecision:
    mode: str  # "face" | "center" | "blur" (rosto pequeno: imagem inteira sobre fundo desfocado)
    offset: float  # 0 = janela encostada à esquerda, 0,5 = centro, 1 = à direita
    note: str


class FaceDetector(Protocol):
    def detect(self, frame: Any) -> list[Face]: ...


class DetectorUnavailable(Exception):
    pass


# ---------------------------------------------------------------------------
# YuNet no onnxruntime


class YuNetDetector:
    """Detector YuNet (saídas cls/obj/bbox por passo 8, 16 e 32), decodificado como no OpenCV."""

    STRIDES = (8, 16, 32)

    def __init__(self, model_path: Path):
        self.model_path = model_path
        self._session = None

    def _load(self):
        if self._session is None:
            if not self.model_path.is_file():
                raise DetectorUnavailable(f"modelo de rosto não encontrado em {self.model_path}")
            try:
                import onnxruntime as ort

                options = ort.SessionOptions()
                options.intra_op_num_threads = 2
                self._session = ort.InferenceSession(str(self.model_path), options, providers=["CPUExecutionProvider"])
            except Exception as err:  # noqa: BLE001 — qualquer falha do runtime vira "indisponível"
                raise DetectorUnavailable(f"não foi possível carregar o detector: {err}") from None
        return self._session

    def detect(self, frame: Any) -> list[Face]:
        """`frame`: array uint8 H×W×3 em BGR."""
        import numpy as np

        session = self._load()
        h, w = frame.shape[:2]
        ph, pw = math.ceil(h / 32) * 32, math.ceil(w / 32) * 32
        blob = np.zeros((1, 3, ph, pw), dtype=np.float32)
        blob[0, :, :h, :w] = frame.transpose(2, 0, 1)
        names = [o.name for o in session.get_outputs()]
        out = dict(zip(names, session.run(None, {session.get_inputs()[0].name: blob})))

        boxes, scores = [], []
        for stride in self.STRIDES:
            cols, rows = pw // stride, ph // stride
            cls = np.clip(out[f"cls_{stride}"][0, :, 0], 0, 1)
            obj = np.clip(out[f"obj_{stride}"][0, :, 0], 0, 1)
            bbox = out[f"bbox_{stride}"][0]
            score = np.sqrt(cls * obj)
            for idx in np.nonzero(score >= SCORE_THRESHOLD)[0]:
                r, c = divmod(int(idx), cols)
                if r >= rows:
                    continue
                cx, cy = (c + bbox[idx, 0]) * stride, (r + bbox[idx, 1]) * stride
                bw, bh = math.exp(float(bbox[idx, 2])) * stride, math.exp(float(bbox[idx, 3])) * stride
                boxes.append((cx - bw / 2, cy - bh / 2, bw, bh))
                scores.append(float(score[idx]))
        return [Face(float(x) / w, float(y) / h, float(bw) / w, float(bh) / h, s) for (x, y, bw, bh), s in nms(boxes, scores, NMS_IOU)]


def nms(boxes: list[tuple[float, float, float, float]], scores: list[float], iou: float) -> list[tuple[tuple[float, float, float, float], float]]:
    order = sorted(range(len(boxes)), key=lambda i: -scores[i])
    kept: list[int] = []
    for i in order:
        if all(_iou(boxes[i], boxes[k]) <= iou for k in kept):
            kept.append(i)
    return [(boxes[i], scores[i]) for i in kept]


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# Quadros do trecho


def sample_times(start: float, duration: float) -> list[float]:
    """Um quadro a cada ~4 s (6 a 15 quadros), longe das bordas do corte."""
    n = max(6, min(15, round(duration / 4)))
    return [start + duration * (i + 0.5) / n for i in range(n)]


def extract_frame(ffmpeg: str, source: Path, at: float, width: int, src_w: int, src_h: int):
    """Um quadro BGR (uint8) com a largura pedida. Só lê o arquivo original."""
    import numpy as np

    height = max(2, round(src_h * width / src_w / 2) * 2)
    out = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-ss", f"{at:.3f}", "-i", str(source), "-frames:v", "1",
         "-vf", f"scale={width}:{height}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        capture_output=True, timeout=60,
    )  # fmt: skip
    if out.returncode != 0 or len(out.stdout) != width * height * 3:
        raise DetectorUnavailable("não foi possível ler quadros do vídeo")
    return np.frombuffer(out.stdout, dtype=np.uint8).reshape(height, width, 3)


# ---------------------------------------------------------------------------
# Decisão


def crop_fraction(src_w: int, src_h: int) -> float:
    """Largura da janela 9:16 em relação à largura do vídeo (1 = não há o que escolher)."""
    return min(1.0, src_h * TARGET_ASPECT / src_w) if src_w > 0 and src_h > 0 else 1.0


def offset_for(center: float, frac: float) -> float:
    """Posição da janela (0–1) para centralizar `center`, limitada às bordas do vídeo."""
    if frac >= 1.0:
        return 0.5
    return max(0.0, min(1.0, (center - frac / 2) / (1 - frac)))


def _center(note: str) -> FramingDecision:
    return FramingDecision("center", 0.5, note)


def _median(values: list[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def choose_framing(detections: list[list[Face]], frac: float) -> FramingDecision:
    """Posição fixa da janela 9:16 a partir dos rostos de cada quadro amostrado."""
    total = len(detections)
    if frac >= 1.0:
        return _center("Vídeo já é vertical: imagem inteira, sem recorte lateral.")
    if total == 0:
        return _center("Sem quadros para analisar: recorte central.")

    frames = [[f for f in faces if f.h >= MIN_FACE_HEIGHT] for faces in detections]
    primaries: list[Face] = []
    group_spans: list[tuple[float, float]] = []
    with_peers = 0
    for faces in frames:
        if not faces:
            continue
        main = max(faces, key=lambda f: f.area)
        primaries.append(main)
        # Rostos de tamanho parecido em cena: se couberem juntos, a janela mostra todos.
        peers = [f for f in faces if f.area >= SECONDARY_AREA * main.area]
        group_spans.append((min(f.x for f in peers), max(f.x + f.w for f in peers)))
        with_peers += len(peers) > 1

    presence = len(primaries) / total
    if presence < MIN_PRESENCE:
        return _center(f"Rosto detectado em só {len(primaries)} de {total} quadros: recorte central.")

    face_height = _median([f.h for f in primaries])
    if face_height < SMALL_FACE_HEIGHT:
        return FramingDecision(
            "blur", 0.5,
            f"O rosto ocupa só {round(face_height * 100)}% da altura: o resto da imagem pode ser conteúdo (tela, slides). "
            "Usado “Fundo desfocado” para não esconder nada.",
        )  # fmt: skip

    left, right = _median([a for a, _ in group_spans]), _median([b for _, b in group_spans])
    several = with_peers >= len(primaries) / 2  # mais de uma pessoa em cena na maior parte do tempo
    if several and right - left <= frac * 0.95:
        center, what = (left + right) / 2, "rostos em cena"
    else:
        center, what = _median([f.cx for f in primaries]), "rosto principal"

    # Estabilidade: o rosto principal precisa caber na janela fixa na maioria dos quadros.
    offset = offset_for(center, frac)
    win_left = offset * (1 - frac)
    inside = sum(1 for f in primaries if f.x >= win_left - 0.01 and f.x + f.w <= win_left + frac + 0.01)
    if inside / len(primaries) < MIN_INSIDE:
        return _center(f"O rosto muda de posição: só ficaria na janela fixa em {inside} de {total} quadros. Recorte central.")

    if abs(center - 0.5) <= CENTER_DEADZONE:
        return FramingDecision("face", 0.5, f"Rosto já centralizado ({inside} de {total} quadros): recorte central.")
    note = f"Enquadrado no {what}, posição fixa em {round(center * 100)}% da largura (rosto na janela em {inside} de {total} quadros)."
    if several and what == "rosto principal":
        note += " Há outra pessoa fora da janela; “Fundo desfocado” mostra todos."
    return FramingDecision("face", round(float(offset), 4), note)


def analyze(detector: FaceDetector, ffmpeg: str, source: Path, start: float, duration: float, src_w: int, src_h: int) -> FramingDecision:
    """Decide o enquadramento do corte. Nunca lança: qualquer falha vira recorte central."""
    frac = crop_fraction(src_w, src_h)
    if frac >= 1.0:
        return choose_framing([], frac)
    times = sample_times(start, duration)
    try:
        best: list[list[Face]] | None = None
        for width in ANALYSIS_WIDTHS:
            detections = [detector.detect(extract_frame(ffmpeg, source, t, width, src_w, src_h)) for t in times]
            found = sum(1 for d in detections if d)
            if best is None or found > sum(1 for d in best if d):
                best = detections
            if found / len(times) >= MIN_PRESENCE:
                break
        return choose_framing(best or [], frac)
    except DetectorUnavailable as err:
        log.warning("Detecção de rosto indisponível (%s); recorte central.", err)
        return _center(f"Detecção de rosto indisponível ({err}): recorte central.")
    except Exception as err:  # noqa: BLE001 — o detector nunca impede a renderização
        log.warning("Falha na detecção de rosto (%s); recorte central.", err)
        return _center("Falha na detecção de rosto: recorte central.")
