"""Loop do worker: busca a fila, transcreve (e, se ativa, seleciona cortes) e reporta.

A seleção de cortes fica em selection.py; aqui está a transcrição e o loop.

Garantias:
  - Só processa projetos em `transcribing` cujo arquivo está em
    `<dados>/media/<id>/`, ou seja, enviados pela própria aplicação.
  - Um projeto concluído vai para `selecting` e sai da fila: não é processado
    de novo. Se o worker cair depois de salvar a transcrição e antes de avisar
    a aplicação, o `transcript.json` é reaproveitado em vez de refeito.
  - Só um worker por pasta de dados (arquivo de trava). Por isso um job que
    aparece como "running" ao iniciar é de uma execução anterior que caiu, e
    é retomado.
  - Se o projeto for excluído ou mudar de estado durante o trabalho (404/409),
    o worker para sem gravar nada.
  - Falhas de processamento viram `failed` com `stage: "transcribe"`, e o
    usuário pode tentar de novo pela interface.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .api import ApiDisabled, ApiError, AppUnreachable, JobGone, Unauthorized, WorkerApi
from .audio import AudioError, extract_audio
from .config import Settings
from .transcribe import ModelMissing, Transcriber, TranscriptResult

log = logging.getLogger("cca_worker")

TRANSCRIPT_FILE = "transcript.json"
TRANSCRIPT_VERSION = 1
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROGRESS_INTERVAL_SEC = 3.0

# Faixas da barra de progresso
P_CLAIM, P_AUDIO, P_TRANSCRIBE_END = 0.01, 0.05, 0.97


class UnsafeJob(Exception):
    """Job com caminho de mídia fora da pasta de dados ou id inválido."""


class FatalConfigError(Exception):
    """Erro que nenhuma nova tentativa resolve (token errado, API desligada)."""


@dataclass
class JobOutcome:
    project_id: str
    result: str  # "completed" | "reused" | "failed" | "cancelled" | "skipped" | "interrupted"
    detail: str = ""


# ---------------------------------------------------------------------------
# Validação e arquivos


def resolve_source(settings: Settings, job: dict[str, Any]) -> Path:
    project_id = str(job.get("projectId") or "")
    if not PROJECT_ID_RE.match(project_id):
        raise UnsafeJob(f"id de projeto inválido: {project_id!r}")
    media = job.get("media") or {}
    raw = media.get("absolutePath")
    if not isinstance(raw, str) or not raw:
        raise UnsafeJob("job sem arquivo de mídia")
    source = Path(raw).resolve()
    expected = (settings.data_dir / "media" / project_id).resolve()
    if source.parent != expected:
        raise UnsafeJob(f"o arquivo não está na pasta de mídia do projeto ({expected})")
    return source


def work_root(settings: Settings) -> Path:
    """Pasta dos arquivos temporários (WAV extraído). Fica fora de media/ de propósito."""
    root = settings.data_dir / "tmp"
    root.mkdir(parents=True, exist_ok=True)
    return root


def clean_stale_workdirs(settings: Settings) -> int:
    """Apaga temporários deixados por uma execução que caiu.

    Só deve ser chamada com a trava de instância única obtida: assim nenhum
    outro worker está usando esses arquivos.
    """
    root = settings.data_dir / "tmp"
    if not root.is_dir():
        return 0
    removed = 0
    for entry in root.iterdir():
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed


def source_fingerprint(source: Path) -> dict[str, Any]:
    st = source.stat()
    return {"file": source.name, "sizeBytes": st.st_size, "mtimeNs": st.st_mtime_ns}


def read_existing_transcript(path: Path, fingerprint: dict[str, Any], settings: Settings) -> dict[str, Any] | None:
    """Retorna a transcrição salva se ela corresponder ao mesmo arquivo e configuração."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    same = (
        data.get("version") == TRANSCRIPT_VERSION
        and data.get("source") == fingerprint
        and data.get("model") == settings.model
        and data.get("requestedLanguage") == (settings.language or "auto")
        and isinstance(data.get("segments"), list)
    )
    return data if same else None


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for attempt in range(5):  # antivírus/indexador do Windows podem segurar o arquivo
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.1 * (attempt + 1))


def build_transcript(project_id: str, fingerprint: dict[str, Any], settings: Settings, result: TranscriptResult, elapsed: float) -> dict[str, Any]:
    return {
        "version": TRANSCRIPT_VERSION,
        "projectId": project_id,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": fingerprint,
        "engine": "faster-whisper",
        "model": settings.model,
        "device": settings.device,
        "computeType": settings.compute_type,
        "requestedLanguage": settings.language or "auto",
        "language": result.language,
        "languageProbability": result.language_probability,
        "durationSec": result.duration_sec,
        "processingSec": round(elapsed, 1),
        "segments": result.segments,
        "text": " ".join(s["text"] for s in result.segments),
    }


def fmt_clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def completion_note(segments: int, words: int, model: str, language: str) -> str:
    return f"Transcrição concluída: {segments} trechos, {words} palavras (modelo {model}, idioma {language})"


# ---------------------------------------------------------------------------
# Processamento de um job


class JobRunner:
    def __init__(self, settings: Settings, api: WorkerApi, transcriber: Transcriber, selector: Any = None, renderer: Any = None):
        self.settings = settings
        self.api = api
        self.transcriber = transcriber
        self.selector = selector  # SelectionStage, ou None para não selecionar
        self.renderer = renderer  # RenderStage, ou None para não renderizar

    def process(self, job: dict[str, Any]) -> JobOutcome:
        if job.get("status") == "rendering":
            if self.renderer is None:
                return JobOutcome(str(job.get("projectId") or "?"), "skipped", "renderização desativada")
            return self.renderer.process(job)
        if job.get("status") == "selecting":
            if self.selector is None:
                return JobOutcome(str(job.get("projectId") or "?"), "skipped", "seleção desativada")
            return self.selector.process(job)
        return self.process_transcription(job)

    def process_transcription(self, job: dict[str, Any]) -> JobOutcome:
        project_id = str(job.get("projectId") or "?")
        try:
            source = resolve_source(self.settings, job)
        except UnsafeJob as err:
            log.error("Projeto %s ignorado: %s", project_id, err)
            return self._fail(project_id, f"Arquivo de mídia inválido: {err}.")

        if not source.is_file():
            return self._fail(project_id, "O arquivo enviado não foi encontrado na pasta de dados. Envie o vídeo novamente.")

        try:
            claimed = self.api.progress(project_id, P_CLAIM, "Preparando o áudio")
        except JobGone as err:
            log.info("Projeto %s mudou antes de começar (%s); ignorado.", project_id, err)
            return JobOutcome(project_id, "skipped", str(err))
        stored = (claimed.get("media") or {}).get("storedPath")
        if claimed.get("status") != "transcribing" or not stored or re.split(r"[\\/]", stored)[-1] != source.name:
            log.info("Projeto %s mudou de arquivo ou de estado; ignorado.", project_id)
            return JobOutcome(project_id, "skipped", "projeto alterado")

        fingerprint = source_fingerprint(source)
        transcript_path = source.parent / TRANSCRIPT_FILE

        existing = read_existing_transcript(transcript_path, fingerprint, self.settings)
        if existing is not None:
            log.info("Projeto %s: transcrição já existia para este arquivo; reaproveitando.", project_id)
            words = sum(len(s.get("words") or []) for s in existing["segments"])
            note = completion_note(len(existing["segments"]), words, existing["model"], existing["language"])
            return self._complete(project_id, note + " — reaproveitada", "reused")

        workdir = Path(tempfile.mkdtemp(prefix=f"{project_id}-", dir=work_root(self.settings)))
        try:
            return self._transcribe(project_id, job, source, fingerprint, transcript_path, workdir)
        except JobGone as err:
            log.info("Projeto %s foi excluído ou alterado durante o trabalho (%s); cancelado.", project_id, err)
            return JobOutcome(project_id, "cancelled", str(err))
        except AppUnreachable as err:
            log.warning("Projeto %s: a aplicação parou de responder (%s). Será retomado quando ela voltar.", project_id, err)
            return JobOutcome(project_id, "interrupted", str(err))
        except AudioError as err:
            return self._fail(project_id, str(err))
        except MemoryError:
            return self._fail(project_id, f"Memória insuficiente para o modelo '{self.settings.model}'. Use um modelo menor (CCA_WHISPER_MODEL=base) ou feche outros programas.")
        except ModelMissing as err:
            return self._fail(project_id, str(err))
        except OSError as err:
            return self._fail(project_id, f"Erro de arquivo durante a transcrição: {err.strerror or err}.")
        except (ApiDisabled, Unauthorized):
            raise
        except Exception as err:  # erro inesperado do decodificador/modelo
            log.exception("Projeto %s: erro inesperado", project_id)
            return self._fail(project_id, f"Erro inesperado na transcrição: {type(err).__name__}: {err}"[:500])
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _transcribe(self, project_id: str, job: dict[str, Any], source: Path, fingerprint: dict[str, Any], transcript_path: Path, workdir: Path) -> JobOutcome:
        duration = (job.get("media") or {}).get("durationSec")
        audio = workdir / "audio-16k.wav"
        log.info("Projeto %s: extraindo áudio de %s", project_id, source.name)
        extract_audio(source, audio, ffmpeg=self.settings.ffmpeg, duration_sec=duration)

        model_label = f"modelo {self.settings.model}"
        self.api.progress(project_id, P_AUDIO, f"Transcrevendo ({model_label})")
        log.info("Projeto %s: transcrevendo com %s em %s/%s", project_id, model_label, self.settings.device, self.settings.compute_type)

        started = time.monotonic()
        last_sent = started

        def on_progress(done: float, total: float) -> None:
            nonlocal last_sent
            now = time.monotonic()
            if now - last_sent < PROGRESS_INTERVAL_SEC or total <= 0:
                return
            last_sent = now
            fraction = min(1.0, done / total)
            self.api.progress(
                project_id,
                P_AUDIO + (P_TRANSCRIBE_END - P_AUDIO) * fraction,
                f"Transcrevendo {fmt_clock(done)} de {fmt_clock(total)} ({model_label})",
            )

        result = self.transcriber.transcribe(audio, on_progress)
        elapsed = time.monotonic() - started
        if not result.segments:
            return self._fail(project_id, "Nenhuma fala foi detectada no áudio. Confira se o vídeo tem voz audível.")

        # Confirma que o projeto ainda existe antes de gravar na pasta dele.
        self.api.progress(project_id, 0.99, "Salvando a transcrição")
        write_json_atomic(transcript_path, build_transcript(project_id, fingerprint, self.settings, result, elapsed))
        speed = result.duration_sec / elapsed if elapsed > 0 else 0
        log.info("Projeto %s: %d trechos, %d palavras em %.0f s (%.1fx tempo real).", project_id, len(result.segments), result.word_count, elapsed, speed)
        note = completion_note(len(result.segments), result.word_count, self.settings.model, result.language)
        return self._complete(project_id, note, "completed")

    def _complete(self, project_id: str, note: str, result: str) -> JobOutcome:
        try:
            self.api.transition(project_id, "selecting", note=note)
        except JobGone as err:
            log.info("Projeto %s mudou antes da conclusão (%s).", project_id, err)
            return JobOutcome(project_id, "cancelled", str(err))
        log.info("Projeto %s → seleção de cortes. %s", project_id, note)
        return JobOutcome(project_id, result, note)

    def _fail(self, project_id: str, message: str) -> JobOutcome:
        log.error("Projeto %s falhou: %s", project_id, message)
        try:
            self.api.transition(project_id, "failed", error={"stage": "transcribe", "message": message})
        except JobGone as err:
            log.info("Projeto %s já tinha mudado (%s).", project_id, err)
        except AppUnreachable as err:
            log.warning("Não foi possível registrar a falha de %s (%s).", project_id, err)
            return JobOutcome(project_id, "interrupted", message)
        return JobOutcome(project_id, "failed", message)


# ---------------------------------------------------------------------------
# Loop


def pending_transcriptions(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [j for j in jobs if j.get("status") == "transcribing" and j.get("media")]


def pending_jobs(jobs: list[dict[str, Any]], with_selection: bool, with_render: bool = False) -> list[dict[str, Any]]:
    """Ordem: transcrições, seleções e renderizações."""
    pending = pending_transcriptions(jobs)
    if with_selection:
        pending += [j for j in jobs if j.get("status") == "selecting" and j.get("media")]
    if with_render:
        pending += [j for j in jobs if j.get("status") == "rendering" and j.get("media")]
    return pending


def run_loop(runner: JobRunner, *, once: bool = False, sleep=time.sleep) -> list[JobOutcome]:
    outcomes: list[JobOutcome] = []
    offline_logged = False
    selector_problem: str | None = None
    while True:
        try:
            jobs = runner.api.list_jobs()
            if offline_logged:
                log.info("Aplicação respondeu de novo.")
            offline_logged = False
        except ApiDisabled as err:
            raise FatalConfigError(f"A API do worker está desligada na aplicação: {err} Depois de definir, reinicie o npm run dev.") from None
        except Unauthorized:
            raise FatalConfigError("Token recusado (401). O CCA_WORKER_TOKEN do worker é diferente do usado pela aplicação; reinicie o npm run dev após alterar o .env.local.") from None
        except AppUnreachable as err:
            if once:
                raise
            if not offline_logged:
                log.warning("%s. Inicie a aplicação (npm run dev); tentando de novo a cada %d s.", err, runner.settings.poll_seconds)
                offline_logged = True
            sleep(runner.settings.poll_seconds)
            continue
        except ApiError as err:
            if once:
                raise
            log.warning("Erro ao consultar a fila: %s", err)
            sleep(runner.settings.poll_seconds)
            continue

        with_selection = runner.selector is not None
        if with_selection and any(j.get("status") == "selecting" for j in jobs):
            problem = runner.selector.check_ready()
            if problem != selector_problem:
                if problem:
                    log.warning("Seleção de cortes pausada: %s. Os projetos continuam na fila.", problem)
                elif selector_problem:
                    log.info("Ollama pronto; retomando a seleção de cortes.")
                selector_problem = problem
            with_selection = problem is None
        pending = pending_jobs(jobs, with_selection, runner.renderer is not None)
        finished = 0
        for job in pending:
            try:
                outcome = runner.process(job)
                outcomes.append(outcome)
                finished += outcome.result in ("completed", "reused", "failed")
            except ApiDisabled as err:
                raise FatalConfigError(f"A API do worker foi desligada: {err}") from None
            except Unauthorized:
                raise FatalConfigError("Token recusado (401) durante o processamento.") from None
        if once:
            return outcomes
        if not finished:  # nada avançou: espera antes de consultar de novo (evita laço apertado)
            sleep(runner.settings.poll_seconds)


# ---------------------------------------------------------------------------
# Trava de instância única


class SingleInstanceLock:
    """Impede dois workers na mesma pasta de dados."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+")
        try:
            if os.name == "nt":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            raise RuntimeError(f"Já existe um worker rodando para esta pasta de dados ({self.path}). Feche-o antes de abrir outro.") from None
        self._fh = fh

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        self._fh.close()
        self._fh = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()
