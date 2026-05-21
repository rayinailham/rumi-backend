// Gemini text-embedding-004 — 768-dim. Used at seed-time and at /reflect runtime.

const MODEL = Deno.env.get("RUMI_EMBEDDING_MODEL") ?? "text-embedding-004";

export interface EmbedResult {
  embedding: number[];
}

export async function embedText(text: string, signal?: AbortSignal): Promise<EmbedResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${key}`;

  const body = {
    model: `models/${MODEL}`,
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gemini_embed_${res.status}: ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  const values: number[] | undefined = json?.embedding?.values;
  if (!values || values.length === 0) {
    throw new Error("gemini_embed_empty");
  }
  return { embedding: values };
}
