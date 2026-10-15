"""Cliente mínimo do Ollama local (http://127.0.0.1:11434).

Só é usado com endereços deste computador (validado em config.py): a
transcrição nunca é enviada para serviços externos.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any


class OllamaError(Exception):
    """Erro do modelo ou do servidor; pode valer a pena tentar de novo."""


class OllamaUnavailable(OllamaError):
    """O Ollama não está rodando ou não respondeu."""


class OllamaModelMissing(OllamaError):
    """O modelo configurado não foi baixado (`ollama pull <modelo>`)."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OllamaClient:
    def __init__(self, base_url: str, timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None, timeout: float | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self._opener.open(req, timeout=timeout or self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = str(json.loads(err.read().decode("utf-8")).get("error") or "")
            except (ValueError, UnicodeDecodeError, AttributeError):
                pass
            if err.code == 404 and "not found" in detail.lower():
                raise OllamaModelMissing(detail) from None
            raise OllamaError(f"Ollama respondeu HTTP {err.code}: {detail or err.reason}") from None
        except (TimeoutError, socket.timeout):
            raise OllamaError(f"O Ollama demorou mais de {timeout or self.timeout:g} s para responder.") from None
        except (urllib.error.URLError, ConnectionError) as err:
            raise OllamaUnavailable(f"Ollama sem resposta em {self.base_url}: {getattr(err, 'reason', err)}") from None
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise OllamaError("O Ollama respondeu algo que não é JSON.") from None
        return value if isinstance(value, dict) else {}

    def version(self) -> str:
        return str(self._request("GET", "/api/version", timeout=5).get("version") or "?")

    def models(self) -> list[str]:
        payload = self._request("GET", "/api/tags", timeout=10)
        return [str(m.get("name")) for m in payload.get("models") or [] if isinstance(m, dict)]

    def has_model(self, name: str) -> bool:
        wanted = name if ":" in name else f"{name}:latest"
        return wanted in self.models()

    def chat_json(self, model: str, messages: list[dict[str, str]], schema: dict[str, Any], options: dict[str, Any]) -> str:
        """Pede uma resposta restrita ao esquema JSON (structured outputs do Ollama)."""
        payload = self._request(
            "POST",
            "/api/chat",
            {"model": model, "messages": messages, "format": schema, "stream": False, "options": options, "keep_alive": "5m"},
        )
        content = (payload.get("message") or {}).get("content")
        if not isinstance(content, str):
            raise OllamaError("Resposta do Ollama sem conteúdo.")
        return content
