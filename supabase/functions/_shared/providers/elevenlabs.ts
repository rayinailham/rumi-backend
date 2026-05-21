// ElevenLabs TTS. Voice "Declan Sage", model eleven_multilingual_v2.
// Returns mp3 bytes, OR a structured failure reason that maps to contract §4.1.

const MODEL = Deno.env.get("RUMI_TTS_MODEL_ID") ?? "eleven_multilingual_v2";
const VOICE = Deno.env.get("RUMI_TTS_VOICE_ID") ?? "Declan Sage";

export type TtsResult =
  | { ok: true; mp3: Uint8Array }
  | { ok: false; reason: "quota_exceeded" | "tts_failed" };

export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) return { ok: false, reason: "tts_failed" };

  // Voice can be either an ID or a name. Resolve once per cold-start.
  const voiceId = await resolveVoiceId(VOICE, key);
  if (!voiceId) return { ok: false, reason: "tts_failed" };

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const body = {
    text,
    model_id: MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error("elevenlabs_fetch_error", e);
    return { ok: false, reason: "tts_failed" };
  }

  if (res.status === 429) return { ok: false, reason: "quota_exceeded" };

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (
      res.status === 401 &&
      /quota|exceed/i.test(detail)
    ) {
      return { ok: false, reason: "quota_exceeded" };
    }
    console.error("elevenlabs_http_error", res.status, detail.slice(0, 200));
    return { ok: false, reason: "tts_failed" };
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0) return { ok: false, reason: "tts_failed" };
  return { ok: true, mp3: buf };
}

let voiceCache: Map<string, string> | null = null;

async function resolveVoiceId(nameOrId: string, key: string): Promise<string | null> {
  // If it already looks like an ID (alnum, no spaces), pass through.
  if (/^[A-Za-z0-9]{16,}$/.test(nameOrId)) return nameOrId;

  if (!voiceCache) {
    try {
      const r = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
        headers: { "xi-api-key": key },
      });
      if (!r.ok) return null;
      const j = await r.json();
      voiceCache = new Map();
      for (const v of j.voices ?? []) {
        if (v.name && v.voice_id) voiceCache.set(v.name.toLowerCase(), v.voice_id);
      }
    } catch (e) {
      console.error("elevenlabs_list_voices_error", e);
      return null;
    }
  }
  return voiceCache.get(nameOrId.toLowerCase()) ?? null;
}
