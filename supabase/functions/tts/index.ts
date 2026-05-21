// /functions/v1/tts/:quote_id  GET
// Idempotent generation. Atomic UPDATE WHERE audio_url IS NULL.
// TTS failures return 200 with audio_url:null + reason. Only quote_not_found is 4xx.

import { preflight } from "../_shared/cors.ts";
import { getDeviceId } from "../_shared/device.ts";
import { jsonError, jsonOk } from "../_shared/errors.ts";
import { admin } from "../_shared/supabase.ts";
import { synthesizeSpeech } from "../_shared/providers/elevenlabs.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const cors = preflight(req);
  if (cors) return cors;

  if (req.method !== "GET") {
    return jsonError(req, "invalid_input", "method not allowed", 405);
  }

  // Device header still required even though TTS doesn't scope by device.
  // Keeps surface uniform; contract §1.1.
  if (!getDeviceId(req)) {
    return jsonError(req, "invalid_input", "X-Device-Id missing or invalid", 400);
  }

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const slugIdx = parts.indexOf("tts");
  const quoteId = slugIdx >= 0 ? parts[slugIdx + 1] ?? "" : "";
  if (!UUID.test(quoteId)) {
    return jsonError(req, "invalid_input", "quote id is not a uuid", 400);
  }

  try {
    return await handle(req, quoteId);
  } catch (e) {
    console.error("tts_unhandled", e);
    return jsonError(req, "internal_error", "unexpected error", 500);
  }
});

async function handle(req: Request, quoteId: string): Promise<Response> {
  const sb = admin();

  const { data: quote, error: qErr } = await sb
    .from("rumi_quotes")
    .select("id, quote_text, audio_url")
    .eq("id", quoteId)
    .maybeSingle();

  if (qErr) {
    console.error("tts_select_error", qErr);
    return jsonError(req, "internal_error", "load failed", 500);
  }
  if (!quote) {
    return jsonError(req, "quote_not_found", "quote not found", 404);
  }

  if (quote.audio_url) {
    return jsonOk(req, { audio_url: quote.audio_url });
  }

  // Generate.
  const tts = await synthesizeSpeech(quote.quote_text);
  if (!tts.ok) {
    // Re-check DB before giving up — a parallel call may have just won.
    const { data: fresh } = await sb
      .from("rumi_quotes")
      .select("audio_url")
      .eq("id", quoteId)
      .maybeSingle();
    if (fresh?.audio_url) return jsonOk(req, { audio_url: fresh.audio_url });
    return jsonOk(req, { audio_url: null, reason: tts.reason });
  }

  // Upload to Storage. Bucket "rumi-audio" is public.
  const path = `${quoteId}.mp3`;
  const { error: upErr } = await sb.storage
    .from("rumi-audio")
    .upload(path, tts.mp3, {
      contentType: "audio/mpeg",
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true,
    });

  if (upErr) {
    console.error("tts_upload_error", upErr);
    // Try to recover from a parallel writer.
    const { data: fresh } = await sb
      .from("rumi_quotes")
      .select("audio_url")
      .eq("id", quoteId)
      .maybeSingle();
    if (fresh?.audio_url) return jsonOk(req, { audio_url: fresh.audio_url });
    return jsonOk(req, { audio_url: null, reason: "tts_failed" });
  }

  const { data: pub } = sb.storage.from("rumi-audio").getPublicUrl(path);
  const publicUrl = pub.publicUrl;

  // Atomic write — only first writer wins.
  const { data: updated, error: updErr } = await sb
    .from("rumi_quotes")
    .update({ audio_url: publicUrl })
    .eq("id", quoteId)
    .is("audio_url", null)
    .select("audio_url")
    .maybeSingle();

  if (updErr) {
    console.error("tts_update_error", updErr);
    return jsonOk(req, { audio_url: null, reason: "tts_failed" });
  }

  if (updated?.audio_url) {
    return jsonOk(req, { audio_url: updated.audio_url });
  }

  // Lost the race — re-read the cached value.
  const { data: cached } = await sb
    .from("rumi_quotes")
    .select("audio_url")
    .eq("id", quoteId)
    .maybeSingle();
  return jsonOk(req, { audio_url: cached?.audio_url ?? publicUrl });
}
