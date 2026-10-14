import { timingSafeEqual } from "node:crypto";

/**
 * A API do worker fica desligada até CCA_WORKER_TOKEN ser definido.
 * O worker envia `Authorization: Bearer <token>`.
 * Retorna uma Response de erro, ou `null` se autorizado.
 */
export function checkWorkerAuth(request: Request): Response | null {
  const expected = process.env.CCA_WORKER_TOKEN;
  if (!expected) {
    return Response.json({ ok: false, error: "API do worker desabilitada. Defina CCA_WORKER_TOKEN em .env.local." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ ok: false, error: "Token inválido." }, { status: 401 });
  }
  return null;
}
