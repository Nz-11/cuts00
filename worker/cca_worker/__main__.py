"""Linha de comando do worker.

  python -m cca_worker                 inicia o worker (fica aguardando a fila)
  python -m cca_worker run --once      processa o que estiver na fila e sai
  python -m cca_worker check           diagnóstico da instalação
  python -m cca_worker download-model  baixa o modelo Whisper configurado (uma vez)
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import platform
import sys

from . import __version__
from .api import ApiDisabled, ApiError, AppUnreachable, Unauthorized, WorkerApi
from .audio import ffmpeg_version
from .config import WORKER_DIR, load_settings
from .runner import FatalConfigError, JobRunner, SingleInstanceLock, clean_stale_workdirs, run_loop
from .transcribe import ModelMissing, WhisperTranscriber, download_model, model_is_downloaded

log = logging.getLogger("cca_worker")


def setup_console() -> None:
    # O console do Windows usa cp1252 por padrão e quebra com acentos/emoji.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def setup_logging(verbose: bool) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    root.addHandler(console)
    logs = WORKER_DIR / "logs"
    logs.mkdir(exist_ok=True)
    file = logging.handlers.RotatingFileHandler(logs / "worker.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file.setFormatter(fmt)
    root.addHandler(file)
    for noisy in ("faster_whisper", "httpx", "huggingface_hub", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def cmd_run(args: argparse.Namespace) -> int:
    settings = load_settings()
    if not settings.token_defined:
        log.error("CCA_WORKER_TOKEN não definido. Coloque-o em .env.local (veja worker/README.md).")
        return 2
    transcriber = WhisperTranscriber(settings)
    try:
        log.info("Carregando o modelo Whisper '%s' (%s, %s, %d threads)…", settings.model, settings.device, settings.compute_type, settings.cpu_threads)
        transcriber.load()
    except ModelMissing as err:
        log.error("%s", err)
        return 2
    api = WorkerApi(settings.app_url, settings.token)
    runner = JobRunner(settings, api, transcriber)
    try:
        with SingleInstanceLock(settings.data_dir / "worker.lock"):
            if removed := clean_stale_workdirs(settings):
                log.info("Removidos %d arquivo(s) temporário(s) de uma execução anterior interrompida.", removed)
            log.info("Worker v%s pronto. Aplicação: %s · dados: %s", __version__, settings.app_url, settings.data_dir)
            if args.once:
                outcomes = run_loop(runner, once=True)
                log.info("Fila processada: %s", ", ".join(f"{o.project_id}={o.result}" for o in outcomes) or "nada pendente")
            else:
                log.info("Aguardando projetos na fila de transcrição (Ctrl+C para sair).")
                run_loop(runner)
    except FatalConfigError as err:
        log.error("%s", err)
        return 2
    except AppUnreachable as err:
        log.error("%s. A aplicação está rodando? (npm run dev)", err)
        return 3
    except RuntimeError as err:
        log.error("%s", err)
        return 4
    except KeyboardInterrupt:
        log.info("Interrompido. Um projeto em andamento será retomado na próxima execução.")
        return 130
    return 0


def cmd_download(args: argparse.Namespace) -> int:
    settings = load_settings()
    if model_is_downloaded(settings.model_path):
        print(f"O modelo '{settings.model}' já está em {settings.model_path}.")
        return 0
    print(f"Baixando o modelo '{settings.model}' do Hugging Face (Systran/faster-whisper-{settings.model}) para {settings.model_path}…")
    print("Isso acontece uma única vez. Depois o worker funciona sem internet.")
    try:
        path = download_model(settings)
    except Exception as err:  # rede, disco, proxy…
        print(f"Falha no download: {type(err).__name__}: {err}", file=sys.stderr)
        return 1
    size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    print(f"Pronto: {path} ({size / 1_000_000:.0f} MB).")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    ok = True

    def line(good: bool | None, label: str, detail: str = "") -> None:
        nonlocal ok
        mark = "OK " if good else ("-- " if good is None else "ERRO")
        if good is False:
            ok = False
        print(f"[{mark:4}] {label}{': ' + detail if detail else ''}")

    py = sys.version_info
    line(py >= (3, 11), "Python", f"{platform.python_version()} ({sys.executable})")
    try:
        settings = load_settings()
    except ValueError as err:
        line(False, "Configuração", str(err))
        return 1
    line(None, "Arquivos de configuração", ", ".join(settings.env_files) or "nenhum (.env.local não encontrado)")

    version = ffmpeg_version(settings.ffmpeg)
    line(version is not None, "FFmpeg", version or f"não encontrado ({settings.ffmpeg})")
    try:
        import ctranslate2
        import faster_whisper

        line(True, "faster-whisper", f"{faster_whisper.__version__} (ctranslate2 {ctranslate2.__version__})")
        if settings.device == "cpu":
            types = ctranslate2.get_supported_compute_types("cpu")
            line(settings.compute_type in types, "Tipo de cálculo na CPU", f"{settings.compute_type} (suportados: {', '.join(sorted(types))})")
    except ImportError as err:
        line(False, "faster-whisper", f"não instalado ({err}). Rode worker\\setup.cmd")

    line(model_is_downloaded(settings.model_path), f"Modelo '{settings.model}'", str(settings.model_path) if model_is_downloaded(settings.model_path) else "não baixado — rode: worker\\start.cmd download-model")
    line(None, "Transcrição", f"idioma {settings.language or 'auto'}, {settings.device}/{settings.compute_type}, {settings.cpu_threads} threads, beam {settings.beam_size}")
    line(settings.data_dir.is_dir(), "Pasta de dados", str(settings.data_dir))
    line(settings.token_defined, "CCA_WORKER_TOKEN", f"definido ({len(settings.token or '')} caracteres)" if settings.token_defined else "não definido em .env.local")

    if settings.token_defined:
        api = WorkerApi(settings.app_url, settings.token, timeout=10)
        try:
            jobs = api.list_jobs()
            waiting = sum(1 for j in jobs if j.get("status") == "transcribing")
            line(True, "API do worker", f"{settings.app_url} respondeu; {waiting} projeto(s) aguardando transcrição")
        except AppUnreachable:
            line(False, "API do worker", f"sem resposta em {settings.app_url}. Rode npm run dev")
        except ApiDisabled:
            line(False, "API do worker", "desligada (503): a aplicação não vê o token. Reinicie o npm run dev depois de editar o .env.local")
        except Unauthorized:
            line(False, "API do worker", "token recusado (401): os valores no worker e na aplicação são diferentes")
        except ApiError as err:
            line(False, "API do worker", str(err))
    print("\nTudo certo." if ok else "\nCorrija os itens marcados com ERRO (veja worker/README.md → Diagnóstico).")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    setup_console()
    parser = argparse.ArgumentParser(prog="cca_worker", description="Worker local de transcrição do Cezario's Clips AI.")
    parser.add_argument("-v", "--verbose", action="store_true", help="logs detalhados")
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run", help="inicia o worker (padrão)")
    run.add_argument("--once", action="store_true", help="processa a fila atual e sai")
    sub.add_parser("check", help="diagnóstico da instalação")
    sub.add_parser("download-model", help="baixa o modelo Whisper configurado")
    args = parser.parse_args(argv)

    if args.command == "check":
        return cmd_check(args)
    if args.command == "download-model":
        return cmd_download(args)
    setup_logging(args.verbose)
    if args.command is None:
        args.once = False
    try:
        return cmd_run(args)
    except ValueError as err:  # configuração inválida
        log.error("%s", err)
        return 2


if __name__ == "__main__":
    sys.exit(main())
