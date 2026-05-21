# Rumi Talk — Backend

Supabase Edge Functions backend for [Rumi Talk FE](https://github.com/rayinailham/Rumi-Talk).

Source of truth: `BACKEND_CONTRACT.md` (FE↔BE contract, locked).
Product context: `rumi-talk-flow.md`.

## Stack
- Supabase Edge Functions (Deno)
- Supabase Postgres + pgvector (HNSW cosine)
- Supabase Storage (`rumi-audio` bucket, public)
- Gemini `text-embedding-004` (768-dim)
- OpenRouter (`deepseek/deepseek-chat-v3.1:free` primary, `google/gemini-2.0-flash-exp:free` fallback)
- ElevenLabs TTS (voice `Declan Sage`, model `eleven_multilingual_v2`)

## Endpoints
- `GET /sessions` — list, ordered `updated_at DESC`
- `GET /sessions/:id` — session + messages
- `PATCH /sessions/:id` — rename
- `DELETE /sessions/:id` — cascade
- `GET /tts/:quote_id` — idempotent audio generation
- `POST /reflect` — SSE: embed → match → stream LLM → persist

All endpoints require header `X-Device-Id: <uuid-v4>`. No auth, no cookies.

## Layout
```
supabase/
├── config.toml
├── functions/
│   ├── _shared/        # cors, errors, device, supabase admin, rate_limit, providers/
│   ├── sessions/
│   ├── tts/
│   └── reflect/
└── seed/               # one-shot quote seeder (Gemini-embed at seed time)
```

## Local dev
```sh
cp .env.example .env
# fill keys
supabase functions serve
```

## Deploy
Functions deployed via Supabase MCP. Migrations live in the Supabase project.
