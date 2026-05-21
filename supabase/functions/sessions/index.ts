// /functions/v1/sessions          GET   list
// /functions/v1/sessions/:id      GET   detail (session + messages)
// /functions/v1/sessions/:id      PATCH rename
// /functions/v1/sessions/:id      DELETE cascade

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { getDeviceId } from "../_shared/device.ts";
import { jsonError, jsonOk } from "../_shared/errors.ts";
import { admin } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const cors = preflight(req);
  if (cors) return cors;

  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return jsonError(req, "invalid_input", "X-Device-Id missing or invalid", 400);
  }

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // Path can be "/sessions" or "/sessions/<id>" — depending on platform routing,
  // it may also include the "/functions/v1/" prefix. Find the slug, take the next.
  const slugIdx = parts.indexOf("sessions");
  const id = slugIdx >= 0 ? parts[slugIdx + 1] ?? null : null;

  try {
    if (!id) {
      if (req.method !== "GET") {
        return jsonError(req, "invalid_input", "method not allowed", 405);
      }
      return await listSessions(req, deviceId);
    }

    if (!isUuid(id)) {
      return jsonError(req, "invalid_input", "session id is not a uuid", 400);
    }

    if (req.method === "GET") return await getSession(req, deviceId, id);
    if (req.method === "PATCH") return await renameSession(req, deviceId, id);
    if (req.method === "DELETE") return await deleteSession(req, deviceId, id);
    return jsonError(req, "invalid_input", "method not allowed", 405);
  } catch (e) {
    console.error("sessions_unhandled", e);
    return jsonError(req, "internal_error", "unexpected error", 500);
  }
});

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string) {
  return UUID.test(v);
}

async function listSessions(req: Request, deviceId: string): Promise<Response> {
  const sb = admin();
  const { data, error } = await sb
    .from("sessions")
    .select("id, title, updated_at")
    .eq("device_id", deviceId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("list_sessions_error", error);
    return jsonError(req, "internal_error", "list failed", 500);
  }
  return jsonOk(req, { sessions: data ?? [] });
}

async function getSession(
  req: Request,
  deviceId: string,
  id: string,
): Promise<Response> {
  const sb = admin();

  const { data: session, error: sErr } = await sb
    .from("sessions")
    .select("id, device_id, title, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (sErr) {
    console.error("get_session_error", sErr);
    return jsonError(req, "internal_error", "load failed", 500);
  }
  // Same 404 for not-exist and not-owned. Contract §1.4.
  if (!session || session.device_id !== deviceId) {
    return jsonError(req, "session_not_found", "session not found", 404);
  }

  const { data: msgs, error: mErr } = await sb
    .from("messages")
    .select(
      "id, role, content, quote_id, quote_text, category, audio_url, status, created_at",
    )
    .eq("session_id", id)
    .order("created_at", { ascending: true });

  if (mErr) {
    console.error("get_messages_error", mErr);
    return jsonError(req, "internal_error", "load failed", 500);
  }

  // Strip role-specific fields the contract doesn't want on user messages.
  const messages = (msgs ?? []).map((m) => {
    if (m.role === "user") {
      return {
        id: m.id,
        role: "user",
        content: m.content,
        created_at: m.created_at,
      };
    }
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      quote_id: m.quote_id,
      quote_text: m.quote_text,
      category: m.category,
      audio_url: m.audio_url,
      status: m.status,
      created_at: m.created_at,
    };
  });

  return jsonOk(req, {
    session: {
      id: session.id,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
    },
    messages,
  });
}

async function renameSession(
  req: Request,
  deviceId: string,
  id: string,
): Promise<Response> {
  let body: { title?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(req, "invalid_input", "invalid JSON", 400);
  }

  const raw = typeof body.title === "string" ? body.title.trim() : "";
  if (raw.length < 1 || raw.length > 200) {
    return jsonError(req, "invalid_input", "title must be 1..200 chars", 400);
  }

  const sb = admin();
  const { data, error } = await sb
    .from("sessions")
    .update({ title: raw, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("device_id", deviceId)
    .select("id, title, updated_at")
    .maybeSingle();

  if (error) {
    console.error("rename_session_error", error);
    return jsonError(req, "internal_error", "rename failed", 500);
  }
  if (!data) return jsonError(req, "session_not_found", "session not found", 404);
  return jsonOk(req, data);
}

async function deleteSession(
  req: Request,
  deviceId: string,
  id: string,
): Promise<Response> {
  const sb = admin();
  // Two-step so we can distinguish "not found / not owned" from "deleted".
  const { data: existing, error: selErr } = await sb
    .from("sessions")
    .select("id, device_id")
    .eq("id", id)
    .maybeSingle();

  if (selErr) {
    console.error("delete_session_select_error", selErr);
    return jsonError(req, "internal_error", "delete failed", 500);
  }
  if (!existing || existing.device_id !== deviceId) {
    return jsonError(req, "session_not_found", "session not found", 404);
  }

  const { error: delErr } = await sb
    .from("sessions")
    .delete()
    .eq("id", id)
    .eq("device_id", deviceId);

  if (delErr) {
    console.error("delete_session_error", delErr);
    return jsonError(req, "internal_error", "delete failed", 500);
  }
  return jsonOk(req, { ok: true });
}

// Re-export for type checker (otherwise unused import warning on corsHeaders).
export { corsHeaders };
