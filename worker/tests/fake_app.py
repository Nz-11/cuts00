"""Servidor HTTP mínimo que imita /api/worker/* da aplicação, para testes."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# Mesmas regras de src/lib/project-status.ts
TRANSITIONS = {
    "awaiting_source": ["transcribing", "failed"],
    "transcribing": ["selecting", "awaiting_source", "failed"],
    "selecting": ["review", "failed"],
    "review": ["rendering", "selecting"],
    "rendering": ["completed", "failed"],
    "completed": ["review", "rendering"],
    "failed": ["awaiting_source", "transcribing", "selecting", "rendering"],
}
PROCESSING = {"transcribing", "selecting", "rendering"}


class FakeApp:
    def __init__(self, token: str = "token-de-teste-123", status: int | None = None):
        self.token = token
        self.forced_status = status  # força uma resposta (ex.: 503) em todas as rotas
        self.projects: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, dict[str, Any] | None, str]] = []
        self.on_progress = None  # callback(project_id, body) para simular mudanças
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()

    def add(self, project_id: str, status: str, stored_path: str, absolute_path: str, duration: float = 2.0, state: str = "queued"):
        self.projects[project_id] = {
            "id": project_id,
            "status": status,
            "job": {"state": state, "progress": 0} if status in PROCESSING else None,
            "media": {"storedPath": stored_path, "durationSec": duration, "hasAudio": True},
            "absolutePath": absolute_path,
            "history": [],
            "error": None,
        }

    def bodies(self, project_id: str, action: str | None = None) -> list[dict[str, Any]]:
        return [b for (m, p, b, _) in self.calls if m == "POST" and p.endswith("/" + project_id) and b and (action is None or b.get("action") == action)]

    def _handler(self):
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status: int, payload: dict[str, Any]):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _auth(self) -> bool:
                if app.forced_status:
                    self._send(app.forced_status, {"ok": False, "error": f"forçado {app.forced_status}"})
                    return False
                if self.headers.get("Authorization") != f"Bearer {app.token}":
                    self._send(401, {"ok": False, "error": "Token inválido."})
                    return False
                return True

            def do_GET(self):
                app.calls.append(("GET", self.path, None, self.headers.get("Authorization", "")))
                if not self._auth():
                    return
                if self.path != "/api/worker/jobs":
                    return self._send(404, {"ok": False})
                jobs = [
                    {"projectId": p["id"], "status": p["status"], "job": p["job"], "media": {**p["media"], "absolutePath": p["absolutePath"]}}
                    for p in app.projects.values()
                    if p["status"] in PROCESSING and p["job"]
                ]
                self._send(200, {"ok": True, "jobs": jobs})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                app.calls.append(("POST", self.path, body, self.headers.get("Authorization", "")))
                if not self._auth():
                    return
                pid = self.path.rsplit("/", 1)[-1]
                project = app.projects.get(pid)
                if not project:
                    return self._send(404, {"ok": False, "error": "Projeto não encontrado."})
                if body.get("action") == "progress":
                    if project["status"] not in PROCESSING or not project["job"]:
                        return self._send(409, {"ok": False, "error": "não está em processamento"})
                    project["job"] = {"state": "running", "progress": body["progress"], "message": body.get("message")}
                    if app.on_progress:
                        app.on_progress(pid, body)
                    return self._send(200, {"ok": True, "project": project})
                if body.get("action") == "transition":
                    to = body["to"]
                    if to not in TRANSITIONS[project["status"]]:
                        return self._send(409, {"ok": False, "error": f"Transição inválida: {project['status']} → {to}."})
                    if to == "failed" and not (body.get("error") or {}).get("message"):
                        return self._send(400, {"ok": False, "error": "error obrigatório"})
                    project["status"] = to
                    project["error"] = body.get("error") if to == "failed" else None
                    project["job"] = {"state": "queued", "progress": 0} if to in PROCESSING else None
                    project["history"].append({"status": to, "note": body.get("note")})
                    return self._send(200, {"ok": True, "project": project})
                self._send(400, {"ok": False, "error": "action inválida"})

        return Handler
