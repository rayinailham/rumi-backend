// /functions/v1/reflect  POST  text/event-stream
// Pipeline (contract §3):
//   pre-stream: validate → rate-limit → ownership → embed
//   stream: session → user_message → (no_match? error) → quote → rumi_message → token×N → done|error
// Abort (§3.5): persist partial content with status=interrupted, no done/error frame.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { getDeviceId } from "../_shared/device.ts";
import { jsonError } from "../_shared/errors.ts";
import { admin } from "../_shared/supabase.ts";
import { checkRateLimit } from "../_shared/rate_limit.ts";
import { embedText } from "../_shared/providers/gemini.ts";
import { streamLLM } from "../_shared/providers/openrouter.ts";
import { rumiSystemPrompt, rumiUserPrompt } from "../_shared/providers/prompts.ts";
import { sseFrame } from "../_shared/sse.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATCH_THRESHOLD = Number(Deno.env.get("RUMI_MATCH_THRESHOLD") ?? 0.5);
const FLUSH_MS = 500;

interface ReflectBody {
  sessionId: string | null;
  keresahan: string;
}

Deno.serve(async (req) => {
  const cors = preflight(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonError(req, "invalid_input", "method not allowed", 405);
  }

  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return jsonError(req, "invalid_input", "X-Device-Id missing or invalid", 400);
  }

  let body: Partial<ReflectBody>;
  try {
    body = await req.json();
  } catch {
    return jsonError(req, "invalid_input", "invalid JSON", 400);
  }

  const keresahan = typeof body.keresahan === "string" ? body.keresahan : "";
  const trimmed = keresahan.trim();
  if (trimmed.length < 1 || keresahan.length > 2000) {
    return jsonError(req, "invalid_input", "keresahan must be 1..2000 chars", 400);
  }

  const sessionId =
    body.sessionId === null || body.sessionId === undefined
      ? null
      : typeof body.sessionId === "string" && UUID.test(body.sessionId)
      ? body.sessionId
      : ":invalid";
  if (sessionId === ":invalid") {
    return jsonError(req, "invalid_input", "sessionId must be uuid or null", 400);
  }

  // Rate limit (contract test #30).
  const rl = await checkRateLimit(deviceId);
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: { code: "rate_limited", message: "too many reflects, slow down" },
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders(req),
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(rl.retryAfterSec),
        },
      },
    );
  }

  // Pre-stream session ownership check (contract §3.1).
  const sb = admin();
  let existingSession: { id: string; title: string; created_at: string; updated_at: string } | null = null;
  if (sessionId) {
    const { data, error } = await sb
      .from("sessions")
      .select("id, device_id, title, created_at, updated_at")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) {
      console.error("reflect_session_lookup", error);
      return jsonError(req, "internal_error", "session lookup failed", 500);
    }
    if (!data || data.device_id !== deviceId) {
      return jsonError(req, "session_not_found", "session not found", 404);
    }
    existingSession = data;
  }

  // Pre-stream embedding (contract §3.2: embedding errors before stream open → HTTP error).
  let embedding: number[];
  try {
    const r = await embedText(keresahan);
    embedding = r.embedding;
  } catch (e) {
    console.error("reflect_embed_error", e);
    return jsonError(req, "embedding_failed", "embedding failed", 502);
  }

  return openStream({
    req,
    deviceId,
    keresahan,
    embedding,
    existingSession,
  });
});

interface StreamCtx {
  req: Request;
  deviceId: string;
  keresahan: string;
  embedding: number[];
  existingSession:
    | { id: string; title: string; created_at: string; updated_at: string }
    | null;
}

function openStream(ctx: StreamCtx): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      runPipeline(ctx, controller).catch((e) => {
        console.error("reflect_pipeline_unhandled", e);
        try {
          controller.enqueue(
            sseFrame("error", {
              code: "internal_error",
              message: "unexpected error",
              retriable: false,
            }),
          );
        } catch { /* already closed */ }
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(ctx.req),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function runPipeline(
  ctx: StreamCtx,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const sb = admin();
  const abort = new AbortController();
  let aborted = false;
  let closed = false;

  const onClientAbort = () => {
    aborted = true;
    abort.abort();
  };
  ctx.req.signal.addEventListener("abort", onClientAbort);

  const send = (event: string, data: unknown): boolean => {
    if (closed || aborted) return false;
    try {
      controller.enqueue(sseFrame(event, data));
      return true;
    } catch {
      closed = true;
      return false;
    }
  };
  const closeStream = () => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* ignore */ }
  };

  // 1. Session — find or create.
  let session = ctx.existingSession;
  let isNew = false;
  if (!session) {
    const title = deriveTitle(ctx.keresahan);
    const ins = await sb
      .from("sessions")
      .insert({ device_id: ctx.deviceId, title })
      .select("id, title, created_at, updated_at")
      .single();
    if (ins.error || !ins.data) {
      console.error("reflect_create_session", ins.error);
      send("error", {
        code: "internal_error",
        message: "session create failed",
        retriable: true,
      });
      closeStream();
      return;
    }
    session = ins.data;
    isNew = true;
  }

  if (
    !send("session", {
      id: session.id,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
      isNew,
    })
  ) {
    return;
  }

  // 2. user_message.
  const userIns = await sb
    .from("messages")
    .insert({
      session_id: session.id,
      role: "user",
      content: ctx.keresahan,
      status: "complete",
    })
    .select("id, content, created_at")
    .single();
  if (userIns.error || !userIns.data) {
    console.error("reflect_insert_user_message", userIns.error);
    send("error", {
      code: "internal_error",
      message: "user message persist failed",
      retriable: true,
    });
    closeStream();
    return;
  }
  send("user_message", userIns.data);

  if (aborted) return;

  // 3. Match quote.
  const { data: matches, error: matchErr } = await sb.rpc("match_rumi_quotes", {
    query_embedding: ctx.embedding as unknown as string,
    match_threshold: MATCH_THRESHOLD,
    match_count: 1,
  });

  if (matchErr) {
    console.error("reflect_match_error", matchErr);
    send("error", {
      code: "embedding_failed",
      message: "match query failed",
      retriable: true,
    });
    closeStream();
    return;
  }

  const top = Array.isArray(matches) && matches.length > 0 ? matches[0] : null;
  if (!top) {
    send("error", {
      code: "no_match",
      message: "no quote passed similarity threshold",
      retriable: false,
    });
    closeStream();
    return;
  }

  const quote = {
    id: top.id as string,
    quote_text: top.quote_text as string,
    category: (top.category ?? null) as string | null,
    audio_url: (top.audio_url ?? null) as string | null,
    similarity: Number(top.similarity ?? 0),
  };
  send("quote", quote);

  if (aborted) return;

  // 4. rumi_message.
  const rumiIns = await sb
    .from("messages")
    .insert({
      session_id: session.id,
      role: "rumi",
      content: "",
      quote_id: quote.id,
      quote_text: quote.quote_text,
      category: quote.category,
      audio_url: quote.audio_url,
      status: "streaming",
    })
    .select("id")
    .single();
  if (rumiIns.error || !rumiIns.data) {
    console.error("reflect_insert_rumi_message", rumiIns.error);
    send("error", {
      code: "internal_error",
      message: "rumi message persist failed",
      retriable: true,
    });
    closeStream();
    return;
  }
  const rumiId = rumiIns.data.id as string;
  send("rumi_message", { id: rumiId, status: "streaming" });

  // 5. Stream tokens with periodic DB flush.
  let buffer = "";
  let lastFlushed = "";
  let flushing = false;

  const flush = async (final: boolean) => {
    if (flushing) return;
    if (buffer === lastFlushed && !final) return;
    flushing = true;
    const snapshot = buffer;
    try {
      await sb
        .from("messages")
        .update({ content: snapshot })
        .eq("id", rumiId);
      lastFlushed = snapshot;
    } catch (e) {
      console.error("reflect_flush_error", e);
    } finally {
      flushing = false;
    }
  };

  const flushTimer = setInterval(() => { flush(false); }, FLUSH_MS);

  const finalize = async (status: "complete" | "interrupted" | "error") => {
    clearInterval(flushTimer);
    // Wait for in-flight flush, then write final state.
    while (flushing) await new Promise((r) => setTimeout(r, 20));
    try {
      await sb
        .from("messages")
        .update({ content: buffer, status })
        .eq("id", rumiId);
    } catch (e) {
      console.error("reflect_finalize_error", e);
    }
    // Touch session updated_at so list ordering reflects activity.
    try {
      await sb
        .from("sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", session!.id);
    } catch { /* non-critical */ }
  };

  let llmFailed = false;
  try {
    const messages = [
      { role: "system" as const, content: rumiSystemPrompt() },
      {
        role: "user" as const,
        content: rumiUserPrompt({
          keresahan: ctx.keresahan,
          quoteText: quote.quote_text,
          category: quote.category,
        }),
      },
    ];

    for await (const delta of streamLLM({ messages, signal: abort.signal })) {
      if (aborted) break;
      buffer += delta;
      if (!send("token", { delta })) {
        // controller died — treat as abort.
        aborted = true;
        break;
      }
    }
  } catch (e) {
    if (!aborted) {
      llmFailed = true;
      console.error("reflect_llm_failed", e);
    }
  }

  ctx.req.signal.removeEventListener("abort", onClientAbort);

  if (aborted) {
    await finalize("interrupted");
    closeStream();
    return;
  }

  if (llmFailed) {
    await finalize("error");
    send("error", {
      code: "llm_failed",
      message: "language model unavailable",
      retriable: true,
    });
    closeStream();
    return;
  }

  await finalize("complete");
  send("done", { id: rumiId, content: buffer, status: "complete" });
  closeStream();
}

function deriveTitle(keresahan: string): string {
  const trimmed = keresahan.trim();
  return trimmed.length <= 60 ? trimmed : trimmed.slice(0, 60);
}
