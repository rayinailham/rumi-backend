// Device ID validation — UUID v4 strict.
// Contract §1.1: missing/malformed → 400 invalid_input.

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidDeviceId(v: unknown): v is string {
  return typeof v === "string" && UUID_V4.test(v);
}

export function getDeviceId(req: Request): string | null {
  const v = req.headers.get("x-device-id");
  return isValidDeviceId(v) ? v.toLowerCase() : null;
}
