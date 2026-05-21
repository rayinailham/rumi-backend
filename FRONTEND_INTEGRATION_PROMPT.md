# Rumi Talk — Frontend Integration Prompt

> Paste this into your FE project's chat session. The agent will wire the UI to the deployed backend without touching design or layout.

---

## Mission

Wire the existing Rumi Talk frontend (github.com/rayinailham/Rumi-Talk, main branch) to the deployed backend. The backend is **fully implemented and tested**. Do **not** redesign UI, do not change layouts, do not introduce new dependencies beyond what the contract requires. Your only job is to replace mock/stub data flows with real API calls per `BACKEND_CONTRACT.md`.

If anything in the FE conflicts with the contract, the **contract wins** — adjust FE state shape, not the API.

---

## Source of truth

1. `BACKEND_CONTRACT.md` (locked, v0.1) — read this first, end to end.
2. `rumi-talk-flow.md` — product UX context.
3. This prompt — wiring details + deployed URLs.

---

## Deployed backend

```
BASE_URL = https://mstqmqxtqgmorqaynnpn.supabase.co/functions/v1
```

Six endpoints, all live and tested:

| Method | Path | Purpose |
|---|---|---|
| GET | `/sessions` | sidebar list |
| GET | `/sessions/:id` | open a session (metadata + full message history) |
| PATCH | `/sessions/:id` | rename |
| DELETE | `/sessions/:id` | hard delete (cascade) |
| GET | `/tts/:quote_id` | lazy audio fetch |
| POST | `/reflect` | SSE stream (the hard one) |

**Auth model:** no auth, no cookies, no JWT. Only header is `X-Device-Id: <uuid-v4>`. Backend functions deployed with `verify_jwt: false`. Do not send `Authorization` or `apikey` headers.

CORS: backend allows any origin in dev. Will be pinned to FE prod URL later — that's a backend concern, not FE.

---

## Required wiring (in order)

### 1. Device ID bootstrap

Run once on app boot (before any API call):

```js
function getDeviceId() {
  let id = localStorage.getItem('rumi_device_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('rumi_device_id', id)
  }
  return id
}
```

Inject into **every fetch** as `X-Device-Id`. No exceptions.

### 2. API client wrapper

Single thin wrapper. No retry logic, no cache layer, no transform — keep it dumb.

```js
const BASE = import.meta.env.VITE_API_BASE
  ?? 'https://mstqmqxtqgmorqaynnpn.supabase.co/functions/v1'

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'X-Device-Id': getDeviceId(),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { code: 'internal_error', message: res.statusText }}))
    throw Object.assign(new Error(err.error?.message ?? res.statusText), {
      code: err.error?.code ?? 'internal_error',
      status: res.status,
    })
  }
  return res
}
```

Set `VITE_API_BASE` in `.env` to the production base URL.

### 3. Sessions CRUD

```js
export const Sessions = {
  list:   ()        => api('/sessions').then(r => r.json()).then(d => d.sessions),
  get:    (id)      => api(`/sessions/${id}`).then(r => r.json()),
  rename: (id, t)   => api(`/sessions/${id}`, { method:'PATCH', body: JSON.stringify({title:t})}).then(r => r.json()),
  remove: (id)      => api(`/sessions/${id}`, { method:'DELETE' }).then(r => r.json()),
}
```

Wire into the existing sidebar component. The sidebar already has rename/delete UI per `rumi-talk-flow.md` §3.4 — replace its data layer.

### 4. TTS (lazy)

```js
export async function getQuoteAudio(quoteId) {
  const res = await api(`/tts/${quoteId}`)
  return res.json()  // { audio_url } or { audio_url: null, reason }
}
```

**TTS failure semantics (critical):** non-200 only when `quote_not_found` (programming error). Otherwise the response is **always 200** with either a URL or `{ audio_url: null, reason }`. Hide the play button when `audio_url` is null. Do NOT treat this as an error toast.

Auto-play rules (contract §6.3):
- Fresh `/reflect` quote with `audio_url` → play immediately when tokens start.
- Fresh `/reflect` quote with `audio_url: null` → fire `getQuoteAudio` in parallel; play when it resolves, only if user hasn't navigated away.
- Historical session loaded via `Sessions.get(id)` → never auto-play; user taps play manually.

### 5. Reflect (SSE) — the hard one

```js
export async function reflect({ sessionId, keresahan, signal, on }) {
  const res = await fetch(`${BASE}/reflect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': getDeviceId(),
    },
    body: JSON.stringify({ sessionId: sessionId ?? null, keresahan }),
    signal,
  })

  // Pre-stream errors come back as JSON 4xx/5xx.
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { code: 'internal_error', message: res.statusText }}))
    throw Object.assign(new Error(err.error?.message ?? res.statusText), {
      code: err.error?.code ?? 'internal_error',
      status: res.status,
    })
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const ev = parseFrame(frame)
        if (ev) on(ev.event, ev.data)
        if (ev?.event === 'done' || ev?.event === 'error') return
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return  // stop button — backend already persisted
    throw e
  }
}

function parseFrame(frame) {
  let event = 'message', data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
    else if (line.startsWith(':')) continue  // SSE comment / heartbeat
  }
  if (!data) return null
  try { return { event, data: JSON.parse(data) } } catch { return null }
}
```

**Event order is fixed (contract §3.2, v0.2):**
```
session → user_message → (quote | no_quote) → rumi_message → token×N → done
                                                                       \→ error (terminal)
```

`quote` and `no_quote` are mutually exclusive — exactly one fires per reflect.
- `quote { id, quote_text, category, audio_url, similarity }` — verse matched.
- `no_quote { reason: "no_match" }` — no verse passed similarity threshold. Rumi still streams a graceful response without an anchor verse. **Do NOT show this as an error**; just skip the quote card UI and let the tokens flow into the rumi bubble.

Wire the `on(event, data)` callback to your store. Reference handler skeleton:

```js
reflect({
  sessionId: currentSessionId,
  keresahan: input,
  signal: abortCtrl.signal,
  on(event, data) {
    switch (event) {
      case 'session':
        // {id, title, created_at, updated_at, isNew}
        if (data.isNew) router.replace(`/chat/${data.id}`)
        store.setActiveSession(data)
        break
      case 'user_message':
        // {id, content, created_at}
        store.appendMessage({ ...data, role: 'user' })
        break
      case 'quote':
        // {id, quote_text, category, audio_url, similarity}
        store.setActiveQuote(data)
        if (data.audio_url) playAudio(data.audio_url)
        else getQuoteAudio(data.id).then(r => r.audio_url && playAudio(r.audio_url))
        break
      case 'no_quote':
        // {reason: 'no_match'}  — no verse this turn; Rumi still speaks
        store.clearActiveQuote()
        break
      case 'rumi_message':
        // {id, status: 'streaming'}
        store.startRumiMessage(data.id)
        break
      case 'token':
        // {delta}
        store.appendDelta(data.delta)
        break
      case 'done':
        // {id, content, status: 'complete'}
        store.finalizeRumiMessage(data)
        break
      case 'error':
        // {code, message, retriable}
        store.errorRumiMessage(data)
        break
    }
  },
}).catch(err => {
  // Pre-stream HTTP errors (invalid_input, session_not_found, rate_limited, embedding_failed)
  store.showError(err.code, err.message)
})
```

### 6. Stop button (cancellation)

Hold an `AbortController` per active stream. Click stop → `abortCtrl.abort()`.

Backend persists buffered content with `status=interrupted` and closes the connection without `done` or `error`. FE simply stops listening — whatever's already rendered is the final state. **Do not** show an error.

On reload mid-stream: `Sessions.get(id)` will return the rumi message with `status: 'interrupted'` and partial `content`. Render as-is. No resume button — `keresahan` stands.

### 7. Concurrent reflects

Allowed (contract §3.6). Multiple tabs / sessions can stream simultaneously. Each has its own `AbortController`. Don't add global locks.

---

## Error code → UX mapping

| code | source | UX |
|---|---|---|
| `invalid_input` | 400 | dev error, log; should not happen if FE validates |
| `session_not_found` | 404 | redirect to `/chat`, clear active session |
| `rate_limited` | 429 | toast: "tunggu sebentar, terlalu cepat" — read `Retry-After` header |
| `embedding_failed` | 502 | toast: "gagal membaca keresahanmu, coba lagi" |
| `no_match` | SSE error | inline: "Rumi sedang berdiam diri" — keresahan persisted, no rumi message |
| `llm_failed` | SSE error | inline retriable: "coba lagi sebentar lagi" |
| `internal_error` | any | generic toast |

---

## Environment

`.env` (or `.env.local`):
```
VITE_API_BASE=https://mstqmqxtqgmorqaynnpn.supabase.co/functions/v1
```

Production: same URL until backend pins CORS to a specific origin.

---

## Verification checklist (run before declaring done)

For each, check FE behavior matches expectation:

1. Fresh visit → device id appears in `localStorage.rumi_device_id`.
2. Empty `GET /sessions` renders empty sidebar (no error).
3. Submit keresahan with `sessionId=null` → URL changes to `/chat/<new-id>` (from `session.isNew`).
4. Tokens render incrementally in the rumi bubble.
5. Audio auto-plays on first reflect when `audio_url` resolves.
6. Stop button mid-stream → message frozen at partial content, no error toast.
7. Reload mid-stream → message shows partial content with interrupted status indicator.
8. Switch sessions → audio does NOT auto-play in historical sessions.
9. Rename session → sidebar updates immediately.
10. Delete session → sidebar item disappears, redirect if active.
11. Submit 11 reflects in <60s → 11th gets `rate_limited` toast.
12. Indonesian and English keresahan both work.
13. Special chars (emoji, newlines, quotes) render correctly in saved messages.

---

## Out of scope — do NOT build

Per contract §7:
- Search across sessions
- Export/share
- Multi-turn memory (Rumi is stateless per pertukaran)
- Pagination
- Quick prompts / suggestion chips
- Notifications, streaks, gamification

If you find FE code already implementing any of these, leave it alone — don't actively remove, but don't wire anything new for them.

---

## When you are done

Reply with:
1. List of files modified
2. Any contract ambiguities you flagged
3. Verification checklist results (pass/fail per row)
4. Anything FE-side that conflicts with the contract and how you reconciled it
