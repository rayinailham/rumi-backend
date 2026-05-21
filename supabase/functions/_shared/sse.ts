// Minimal SSE frame encoder.
// Frame format: `event: NAME\ndata: JSON\n\n`

const enc = new TextEncoder();

export function sseFrame(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return enc.encode(`event: ${event}\ndata: ${json}\n\n`);
}

// Periodic comment-only frame to keep proxies from buffering.
export function sseHeartbeat(): Uint8Array {
  return enc.encode(`: keepalive\n\n`);
}
