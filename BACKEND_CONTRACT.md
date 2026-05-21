# Rumi Talk — Backend Contract

Version: 0.1 (locked before implementation)
Stack: Supabase Edge Functions (Deno) + Postgres + Storage
Providers: Gemini (embedding), OpenRouter (LLM stream), ElevenLabs (TTS, voice `Declan Sage`)

This document is the source of truth for the FE↔BE contract. Implementation must match exactly.

---

## 1. Conventions

### 1.1 Identity

All endpoints require:

```
X-Device-Id: <uuid-v4>
```

Frontend generates a UUID v4 once on first visit, stores it in `localStorage.rumi_device_id`, and sends it on every request. There is no auth, no cookies. All `sessions` and `messages` rows are scoped by this ID server-side.

Missing or malformed header → `400 invalid_input`.

### 1.2 Base URL

```
{SUPABASE_URL}/functions/v1/{endpoint}
```

Frontend talks to one base URL. CORS is open for the deployed frontend origin.

Edge Functions are deployed with `verify_jwt: false` (config.toml). Frontend does **not** send `Authorization` or `apikey` headers — `X-Device-Id` is the only identity. Each function still validates the device header on every request.

### 1.3 Content types

- Request body: `application/json` unless specified.
- Response body: `application/json` unless specified.
- Streaming endpoint: `text/event-stream` (SSE, parsed manually on FE).

### 1.4 Error format

Every 4xx/5xx response uses this shape:

```json
{ "error": { "code": "string", "message": "human readable" } }
```

Error codes used in this contract:

| code | meaning |
|---|---|
| `invalid_input` | missing/invalid header or body |
| `session_not_found` | sessionId does not exist OR not owned by this device |
| `rate_limited` | per-device rate limit hit |
| `embedding_failed` | Gemini embedding API failure |
| `llm_failed` | OpenRouter call failed (after fallback) |
| `no_match` | no quote passed similarity threshold |
| `tts_failed` | ElevenLabs failure (used as `reason` in TTS response, not HTTP error) |
| `quota_exceeded` | ElevenLabs monthly quota hit (used as `reason`) |
| `quote_not_found` | TTS endpoint, quote id does not exist |
| `rate_limited` | always paired with HTTP `429` |
| `internal_error` | unhandled |

Note: `session_not_found` is returned both when the row doesn't exist and when it exists but `device_id` mismatches. Never reveal existence.

---

## 2. Sessions

### 2.1 GET /sessions

List all sessions for this device, ordered by `updated_at DESC`.

**Response 200:**

```json
{
  "sessions": [
    {
      "id": "uuid",
      "title": "string (≤200)",
      "updated_at": "ISO-8601"
    }
  ]
}
```

Empty list returns `{ "sessions": [] }`. Never 404.

### 2.2 GET /sessions/:id

Open a session — returns metadata and full message history in chronological order.

**Response 200:**

```json
{
  "session": {
    "id": "uuid",
    "title": "string",
    "created_at": "ISO-8601",
    "updated_at": "ISO-8601"
  },
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "content": "string",
      "created_at": "ISO-8601"
    },
    {
      "id": "uuid",
      "role": "rumi",
      "content": "string (penjelasan, possibly partial if interrupted)",
      "quote_id": "uuid|null",
      "quote_text": "string|null",
      "category": "string|null",
      "audio_url": "string|null",
      "status": "complete|streaming|interrupted|error",
      "created_at": "ISO-8601"
    }
  ]
}
```

**Errors:** `404 session_not_found`.

### 2.3 PATCH /sessions/:id

Rename a session.

**Request:** `{ "title": "string (1..200)" }`
**Response 200:** `{ "id", "title", "updated_at" }`
**Errors:** `404 session_not_found`, `400 invalid_input` (empty/too long title).

### 2.4 DELETE /sessions/:id

Hard delete session and all its messages (FK cascade).

**Response 200:** `{ "ok": true }`
**Errors:** `404 session_not_found`.

---

## 3. Reflect — core SSE endpoint

### 3.1 POST /reflect

Single round-trip: embed keresahan → match quote → stream LLM penjelasan → persist.

**Request:**

```json
{
  "sessionId": "uuid|null",
  "keresahan": "string (1..2000)"
}
```

If `sessionId` is `null`, backend auto-creates a session. Title is derived as `keresahan.trim().slice(0, 60)` — outer whitespace stripped, internal whitespace and newlines preserved verbatim, no ellipsis appended. This matches the "submit pertama → URL berubah jadi /chat/<id>" flow and avoids a separate POST /sessions call.

If `sessionId` is provided but not owned by this device → `404 session_not_found` (no event stream is started).

**Response:** `200 text/event-stream`

Headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

### 3.2 SSE event sequence

Events are emitted in this order. Each event is a single SSE frame (`event: NAME\ndata: JSON\n\n`).

```
1. session         (always, even if existing — confirms target)
2. user_message    (after row inserted)
3. quote           (after match found)
4. rumi_message    (after row inserted, status=streaming)
5. token           (one or more, deltas concatenate to final content)
6. done            (terminal, normal path)

OR

6. error           (terminal, anything fails after stream started)
```

Pre-stream failures (validation, session ownership, embedding error before quote found) return a normal HTTP error with the standard error JSON — no event stream is opened.

### 3.3 Event payloads

**`session`**
```json
{
  "id": "uuid",
  "title": "string",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "isNew": true|false
}
```
`isNew` true if backend just created it. FE uses this to push `/chat/:id` to history.

**`user_message`**
```json
{ "id": "uuid", "content": "string", "created_at": "ISO-8601" }
```

**`quote`**
```json
{
  "id": "uuid",
  "quote_text": "string",
  "category": "string",
  "audio_url": "string|null",
  "similarity": 0.83
}
```
`audio_url` may be `null` — FE fires `GET /tts/:id` separately if needed.

**`rumi_message`**
```json
{ "id": "uuid", "status": "streaming" }
```
Emitted once, before any `token` event. FE binds future `token` deltas to this id.

**`token`**
```json
{ "delta": "string fragment" }
```
Emitted N times. Concatenating all deltas in order yields the final `content`.

**`done`**
```json
{ "id": "uuid", "content": "string (full)", "status": "complete" }
```
Terminal. Stream closes after this frame.

**`error`**
```json
{
  "code": "embedding_failed|llm_failed|no_match|internal_error",
  "message": "string",
  "retriable": true|false
}
```
Terminal. Stream closes. If `error` fires after `rumi_message`, the row is updated to `status=error` with whatever content was buffered.

### 3.4 Streaming behavior

- LLM output capped at **400 output tokens** (server-side, prevents drift).
- Final saved `content` always matches the concatenation of all `token` deltas FE received.
- On client disconnect (see §3.5), whatever has been streamed so far is persisted.

> Implementation note (non-contract): backend buffers tokens and flushes to DB on a periodic timer (~500ms) rather than per-token, plus a final flush on `done` or disconnect. FE must not depend on flush cadence.

### 3.5 Cancellation (stop button)

FE aborts the `fetch`. Backend detects client disconnect via the request signal:

1. Stop reading from LLM.
2. Persist current buffered content.
3. Update message `status = "interrupted"`.
4. No `done` or `error` event is sent (connection is already closed).

On reload mid-stream, FE calls `GET /sessions/:id` and finds the message with `status=interrupted` and partial content. No recovery resumption — keresahan stands as-is.

### 3.6 Concurrent reflects

A device may submit a new reflect while a previous one is still streaming (e.g. on a different tab). Both proceed independently. No locking. Sessions are independent rows.

### 3.7 LLM provider

Primary: `deepseek/deepseek-chat-v3.1:free` via OpenRouter.
Fallback: `google/gemini-2.0-flash-exp:free` if primary returns 429 or 5xx.
If both fail → `error event { code: llm_failed, retriable: true }`.

---

## 4. TTS — on-demand audio

### 4.1 GET /tts/:quote_id

Returns the audio URL for a quote, generating it once on first call.

**Response 200 — already cached or freshly generated:**

```json
{ "audio_url": "https://...mp3" }
```

**Response 200 — generation failed but quote exists:**

```json
{ "audio_url": null, "reason": "tts_failed" }
```

**Response 200 — ElevenLabs quota exhausted:**

```json
{ "audio_url": null, "reason": "quota_exceeded" }
```

**Response 404:**

```json
{ "error": { "code": "quote_not_found", "message": "..." } }
```

Note: TTS failures intentionally return `200` (with `audio_url: null`), not HTTP error. The audio is non-critical — frontend should render the quote with the play button hidden/disabled. Only `quote_not_found` is a true 4xx (programming error).

### 4.2 Generation flow

```
1. SELECT audio_url FROM rumi_quotes WHERE id = $1
2. If not null → return { audio_url }
3. If null:
   a. Call ElevenLabs TTS (voice: Declan Sage, model: eleven_multilingual_v2)
   b. On 429/quota error → return { audio_url: null, reason: "quota_exceeded" }
   c. On other failure → return { audio_url: null, reason: "tts_failed" }
   d. On success: upload mp3 to Storage path: rumi-audio/{quote_id}.mp3
   e. UPDATE rumi_quotes SET audio_url = <public_url>
      WHERE id = $1 AND audio_url IS NULL
   f. Return { audio_url }
```

The `WHERE audio_url IS NULL` clause makes parallel calls safe — only one wins, others return the cached value on retry.

---

## 5. Edge case test matrix

These must all pass before backend is considered reliable.

| # | Scenario | Expected |
|---|---|---|
| 1 | `X-Device-Id` missing | `400 invalid_input` |
| 2 | `X-Device-Id` not a valid UUID | `400 invalid_input` |
| 3 | `keresahan` empty/whitespace only | `400 invalid_input` |
| 4 | `keresahan` > 2000 chars | `400 invalid_input` |
| 5 | `/reflect` with `sessionId: null` | session auto-created, `session` event has `isNew: true` |
| 6 | `/reflect` with valid existing `sessionId` | uses existing, `isNew: false` |
| 7 | `/reflect` with `sessionId` owned by different device | `404 session_not_found`, no stream opened |
| 8 | `/reflect` with non-existent `sessionId` | `404 session_not_found` |
| 9 | Gemini embedding API returns 5xx | `error` event `embedding_failed`, no message rows persisted |
| 10 | No quote ≥ similarity threshold (0.5) | `error` event `no_match`, user_message persisted, no rumi_message |
| 11 | OpenRouter primary 429 | fallback to Gemini Flash, stream continues |
| 12 | Both LLM providers fail | `error` event `llm_failed`, rumi_message status=error with empty content |
| 13 | Client disconnects mid-stream | message status=interrupted, partial content saved |
| 14 | Reload mid-stream | `GET /sessions/:id` returns interrupted message with partial content |
| 15 | Two parallel `/reflect` from same device | both succeed independently |
| 16 | `GET /tts/:id` for quote with audio_url null, fresh generation succeeds | returns URL, DB updated |
| 17 | `GET /tts/:id` for quote with audio_url already set | returns cached URL, no ElevenLabs call |
| 18 | 10 parallel `GET /tts/:id` for same quote_id, audio_url null | only one ElevenLabs call, all 10 receive same URL |
| 19 | `GET /tts/:id` ElevenLabs quota exhausted | `200 { audio_url: null, reason: "quota_exceeded" }`, DB unchanged |
| 20 | `GET /tts/:id` for non-existent quote_id | `404 quote_not_found` |
| 21 | `PATCH /sessions/:id` with empty title | `400 invalid_input` |
| 22 | `PATCH /sessions/:id` not owned by device | `404 session_not_found` |
| 23 | `DELETE /sessions/:id` not owned by device | `404 session_not_found` |
| 24 | `DELETE /sessions/:id` with messages | session and all messages removed (cascade) |
| 25 | `GET /sessions` with no sessions | `{ sessions: [] }` |
| 26 | `GET /sessions/:id` for interrupted/error message | included, status reflects state, content is partial |
| 27 | `/reflect` keresahan in English | works (Gemini embedding is multilingual) |
| 28 | `/reflect` keresahan in Indonesian | works |
| 29 | Special chars in keresahan (emoji, quotes, newlines) | preserved verbatim in DB |
| 30 | Per-device rate limit (>10 reflect/min) | `429 rate_limited` |

---

## 6. Frontend integration notes

### 6.1 SSE consumption

Cannot use `EventSource` (no custom header support). Use `fetch` + `ReadableStream`:

```js
const res = await fetch('/functions/v1/reflect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
  body: JSON.stringify({ sessionId, keresahan }),
  signal: abortController.signal
})

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  // parse SSE frames separated by \n\n
  const frames = buffer.split('\n\n')
  buffer = frames.pop() // last is incomplete
  for (const frame of frames) handleFrame(frame)
}
```

### 6.2 Stop button

Call `abortController.abort()`. Backend will save partial state. FE can immediately show whatever was rendered as final.

### 6.3 Audio playback

After receiving `quote` event:
- If `audio_url` not null → play immediately on first reflect.
- If null → fire `GET /tts/:id` in parallel with token streaming. When TTS resolves with a URL, play it (only if user hasn't navigated away). If `audio_url: null` returned, hide play button.
- For historical sessions (loaded via `GET /sessions/:id`), do NOT auto-play — user taps play manually.

### 6.4 device_id bootstrap

```js
let deviceId = localStorage.getItem('rumi_device_id')
if (!deviceId) {
  deviceId = crypto.randomUUID()
  localStorage.setItem('rumi_device_id', deviceId)
}
```

---

## 7. Out of contract (deliberately not covered)

- Search across sessions
- Export/share sessions
- Multi-turn memory within session
- Audio caching at CDN edge (Supabase Storage public URLs already CDN-served)
- Pagination on `GET /sessions` — assumed under 1000 sessions per device
- Pagination on messages within a session — assumed under 100 exchanges

If any of these become needed, this document gets a v0.2.

---

## 8. Implementation order (post-contract)

1. Shared utils (device validation, error helpers, supabase admin client)
2. `GET /sessions`, `GET /sessions/:id`, `PATCH /sessions/:id`, `DELETE /sessions/:id`
3. `GET /tts/:quote_id`
4. `POST /reflect` (the hard one — SSE, embedding, LLM fallback, partial persistence)
5. Edge-case tests against this matrix
