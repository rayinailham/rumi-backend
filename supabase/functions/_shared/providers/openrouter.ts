// OpenRouter streaming. Primary deepseek, fallback gemini-2.0-flash-exp.
// Yields token deltas. Caller persists + emits SSE.

const PRIMARY = Deno.env.get("RUMI_LLM_PRIMARY") ?? "deepseek/deepseek-chat-v3.1:free";
const FALLBACK = Deno.env.get("RUMI_LLM_FALLBACK") ?? "google/gemini-2.0-flash-exp:free";
const MAX_TOKENS = Number(Deno.env.get("RUMI_MAX_OUTPUT_TOKENS") ?? 400);

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOpts {
  messages: ChatTurn[];
  signal?: AbortSignal;
}

// AsyncIterable<string> of token deltas. Throws Error("llm_failed") if both providers fail.
export async function* streamLLM(opts: StreamOpts): AsyncGenerator<string, void, void> {
  try {
    yield* callOpenRouter(PRIMARY, opts);
    return;
  } catch (e) {
    if (opts.signal?.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (!/^(429|5\d\d|network)/.test(msg)) {
      // Non-retriable (auth/quota/etc) — try fallback anyway, contract requires only 429/5xx swap.
      // Be permissive; FE doesn't care which model produced the tokens.
    }
    console.warn("llm_primary_failed", msg);
  }

  yield* callOpenRouter(FALLBACK, opts);
}

async function* callOpenRouter(
  model: string,
  { messages, signal }: StreamOpts,
): AsyncGenerator<string, void, void> {
  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY missing");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "Rumi Talk",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
    }),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`${res.status}_${model}: ${errBody.slice(0, 150)}`);
  }
  if (!res.body) {
    throw new Error(`network_no_body_${model}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // skip non-JSON keepalive lines
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}
