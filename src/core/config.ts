export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  BRIDGE_TOKEN?: string;
  DATA_KEY_B64?: string;
  SESSION_LEASE_MS?: string; SESSION_IDLE_MS?: string; SESSION_MAX_MS?: string;
  READ_WAIT_MS?: string; WAKE_TIMEOUT_MS?: string; MAX_WAKE_ATTEMPTS?: string;
  JOB_LEASE_MS?: string; GATEWAY_LEASE_MS?: string; MAX_DELIVERY_ATTEMPTS?: string;
  SUBSCRIPTION_TTL_MS?: string; SECRET_ROTATION_MS?: string; VERIFY_WAIT_MS?: string;
}

function setting(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error("invalid_configuration");
  return n;
}

export function config(env: Env) {
  return {
    leaseMs: setting(env.SESSION_LEASE_MS, 90_000, 1_000, 600_000),
    idleMs: setting(env.SESSION_IDLE_MS, 120_000, 1_000, 3_600_000),
    maxSessionMs: setting(env.SESSION_MAX_MS, 3_600_000, 1_000, 86_400_000),
    readWaitMs: setting(env.READ_WAIT_MS, 20_000, 0, 25_000),
    wakeTimeoutMs: setting(env.WAKE_TIMEOUT_MS, 60_000, 1_000, 600_000),
    maxWakeAttempts: setting(env.MAX_WAKE_ATTEMPTS, 3, 1, 10),
    jobLeaseMs: setting(env.JOB_LEASE_MS, 30_000, 1_000, 120_000),
    gatewayLeaseMs: setting(env.GATEWAY_LEASE_MS, 90_000, 1_000, 600_000),
    maxDeliveryAttempts: setting(env.MAX_DELIVERY_ATTEMPTS, 3, 1, 10),
    subscriptionTtlMs: setting(env.SUBSCRIPTION_TTL_MS, 86_400_000, 1_000, 2_592_000_000),
    rotationMs: setting(env.SECRET_ROTATION_MS, 60_000, 1_000, 600_000),
    verifyWaitMs: setting(env.VERIFY_WAIT_MS, 20_000, 1_000, 25_000),
  };
}
export type Config = ReturnType<typeof config>;
