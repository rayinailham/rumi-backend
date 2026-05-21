// Gemini embedding. Default gemini-embedding-001 (3072-dim native), truncated to 768
// via outputDimensionality to match the seed-time embeddings already in the DB.
// Note: text-embedding-004 was deprecated; the v1beta API now serves only the
// gemini-embedding-* family.

const MODEL = Deno.env.get("RUMI_EMBEDDING_MODEL") ?? "gemini-embedding-001";
const DIMS = Number(Deno.env.get("RUMI_EMBEDDING_DIMS") ?? 768);

export interface EmbedResult {
  embedding: number[];
}

export async function embedText(text: string, signal?: AbortSignal): Promise<EmbedResult> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${key}`;

  const body = {
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY",
    outputDimensionality: DIMS,
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
