// Per-device rate limit. Contract §5 case 30: >10 reflect/min → 429 rate_limited.
// Implemented via reflect_rate_limits table (window_start truncated to minute, atomic upsert).

import { admin } from "./supabase.ts";

const LIMIT = Number(Deno.env.get("RUMI_RATE_LIMIT_PER_MIN") ?? 10);

export async function checkRateLimit(
  deviceId: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const sb = admin();

  // RPC returns the new count after atomic increment in current minute window.
  const { data, error } = await sb.rpc("bump_reflect_rate", {
    p_device_id: deviceId,
  });

  if (error) {
    // Fail-open: rate-limit infra failure shouldn't 500 the user.
    console.error("rate_limit_rpc_error", error);
    return { allowed: true, retryAfterSec: 0 };
  }

  const count = Number(data ?? 0);
  if (count <= LIMIT) return { allowed: true, retryAfterSec: 0 };

  // Seconds until next minute window.
  const now = new Date();
  const retry = 60 - now.getUTCSeconds();
  return { allowed: false, retryAfterSec: retry };
}
