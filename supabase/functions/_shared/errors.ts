// Standard error envelope per contract §1.4.
// Shape: { error: { code, message } }

import { corsHeaders } from "./cors.ts";

export type ErrorCode =
  | "invalid_input"
  | "session_not_found"
  | "rate_limited"
  | "embedding_failed"
  | "llm_failed"
  | "no_match"
  | "tts_failed"
  | "quota_exceeded"
  | "quote_not_found"
  | "internal_error";

export function jsonError(
  req: Request,
  code: ErrorCode,
  message: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: {
        ...corsHeaders(req),
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export function jsonOk(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
