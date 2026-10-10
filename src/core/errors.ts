export class BridgeError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function requireValue(condition: unknown, code: string, status = 409): asserts condition {
  if (!condition) throw new BridgeError(code, status);
}
export function string(value: unknown, name: string, max = 512) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= max, `invalid_${name}`, 400);
  return value;
}
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
