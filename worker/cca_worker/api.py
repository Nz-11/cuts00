"""Cliente da API do worker exposta pela aplicação Next.js.

Contrato (ver worker/README.md e src/app/api/worker/*):
  GET  /api/worker/jobs
  POST /api/worker/projects/:id   {action: "progress" | "transition", ...}

Segurança:
  - O token vai só no cabeçalho Authorization e nunca aparece em mensagens.
  - Proxies do sistema são ignorados e redirecionamentos são recusados, para
    o token não ser enviado a outro endereço.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AppUnreachable(ApiError):
    """A aplicação não respondeu (não está rodando, porta errada…)."""


class ApiDisabled(ApiError):
    """503: a aplicação está sem CCA_WORKER_TOKEN."""


class Unauthorized(ApiError):
    """401: token diferente do configurado na aplicação."""


class JobGone(ApiError):
    """404/409: o projeto foi excluído ou mudou de estado; o trabalho deve parar."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


class WorkerApi:
    def __init__(self, base_url: str, token: str | None, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self._token = token or ""
        self.timeout = timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __repr__(self) -> str:
        return f"WorkerApi({self.base_url!r})"

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_unredirected_header("Authorization", f"Bearer {self._token}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with self._opener.open(req, timeout=self.timeout) as res:
                return _decode(res.read())
        except urllib.error.HTTPError as err:
            payload = _decode(err.read(), tolerant=True)
            message = str(payload.get("error") or f"HTTP {err.code}")
            if err.code == 503:
                raise ApiDisabled(message, err.code) from None
            if err.code == 401:
                raise Unauthorized(message, err.code) from None
            if err.code in (404, 409):
                raise JobGone(message, err.code) from None
            raise ApiError(message, err.code) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            reason = getattr(err, "reason", err)
            raise AppUnreachable(f"Sem resposta de {self.base_url}: {reason}") from None

    def list_jobs(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/worker/jobs")
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise ApiError("Resposta inesperada de /api/worker/jobs.")
        return jobs

    def progress(self, project_id: str, progress: float, message: str) -> dict[str, Any]:
        body = {"action": "progress", "progress": round(min(1.0, max(0.0, progress)), 4), "message": message[:200]}
        return self._request("POST", self._project_path(project_id), body).get("project") or {}

    def transition(
        self, project_id: str, to: str, *, note: str | None = None, error: dict[str, str] | None = None, clips: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"action": "transition", "to": to}
        if clips is not None:
            body["clips"] = clips
        if note:
            body["note"] = note[:200]
        if error:
            body["error"] = {"stage": error["stage"], "message": error["message"][:500]}
        return self._request("POST", self._project_path(project_id), body).get("project") or {}

    def clip_render(self, project_id: str, clip_id: str, state: str, **fields: Any) -> dict[str, Any]:
        """Estado da renderização de um corte: running (progress), done (file, sizeBytes, durationSec) ou failed (error)."""
        body: dict[str, Any] = {"action": "clip", "clipId": clip_id, "state": state, **fields}
        if "error" in body:
            body["error"] = str(body["error"])[:500]
        return self._request("POST", self._project_path(project_id), body).get("project") or {}

    @staticmethod
    def _project_path(project_id: str) -> str:
        return "/api/worker/projects/" + urllib.parse.quote(project_id, safe="")


def _decode(raw: bytes, tolerant: bool = False) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        if tolerant:
            return {}
        raise ApiError("A aplicação respondeu algo que não é JSON.") from None
    return value if isinstance(value, dict) else {}
