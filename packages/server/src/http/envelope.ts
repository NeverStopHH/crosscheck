import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const HTTP_OK: ContentfulStatusCode = 200;

export const ok = <T>(
  c: Context,
  data: T,
  status: ContentfulStatusCode = HTTP_OK,
): Response => c.json({ ok: true, data }, status);

export const fail = (
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response => c.json({ ok: false, error: { code, message } }, status);