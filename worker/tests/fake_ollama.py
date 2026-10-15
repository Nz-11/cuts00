"""Servidor que imita a API do Ollama (/api/version, /api/tags, /api/chat) para testes."""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable


def window_of(body: dict[str, Any]) -> tuple[int, int]:
    match = re.search(r"entre \[(\d+)\] e \[(\d+)\]", body["messages"][-1]["content"])
    assert match, "o prompt deveria indicar a janela"
    return int(match.group(1)), int(match.group(2))


def good_reply(body: dict[str, Any]) -> str:
    """Sugere um corte de 5 trechos no começo de cada janela."""
    first, _ = window_of(body)
    return json.dumps(
        {
            "clips": [
                {
                    "start_segment": first,
                    "end_segment": first + 4,
                    "title": f"Momento {first}",
                    "hook": "Você não vai acreditar",
                    "reason": "Ideia completa com gancho forte.",
                    "ratings": {"hook": 4, "clarity": 4, "value": 3 + first % 3, "standalone": 4, "pacing": 3},
                    "tags": ["Dica", "dica", "carreira"],
                }
            ]
        },
        ensure_ascii=False,
    )


class FakeOllama:
    def __init__(self, models: tuple[str, ...] = ("qwen2.5:7b",), reply: Callable[[dict[str, Any]], str] = good_reply):
        self.models = list(models)
        self.reply = reply
        self.chats: list[dict[str, Any]] = []
        self.fail_chat_with: int | None = None  # status HTTP para simular erro no /api/chat
        self.delay = 0.0  # segundos antes de responder ao /api/chat (simula modelo lento)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.stop()

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def _handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status: int, payload: dict[str, Any]):
                raw = json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionError):
                    pass  # o cliente desistiu (tempo esgotado)

            def do_GET(self):
                if self.path == "/api/version":
                    return self._send(200, {"version": "0.0-test"})
                if self.path == "/api/tags":
                    return self._send(200, {"models": [{"name": m} for m in fake.models]})
                self._send(404, {"error": "not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))
                if self.path != "/api/chat":
                    return self._send(404, {"error": "not found"})
                if body.get("model") not in fake.models:
                    return self._send(404, {"error": f"model '{body.get('model')}' not found"})
                fake.chats.append(body)
                if fake.delay:
                    time.sleep(fake.delay)
                if fake.fail_chat_with:
                    return self._send(fake.fail_chat_with, {"error": "falha simulada"})
                self._send(200, {"message": {"role": "assistant", "content": fake.reply(body)}, "done": True})

        return Handler
