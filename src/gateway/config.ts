import { resolve } from "node:path";
import { readPrivateJson } from "./storage.ts";

export interface GatewayConfig {
  bridgeUrl: string; bridgeToken: string; sitesAccessToken?: string;
  runtimeDir: string; tickMs: number; qrRefreshLimit: number; qrTimeoutMs: number;
  routeTag?: string;
  ilinkVersion?:string;
}

export async function loadConfig(path = ".runtime/gateway.json"): Promise<GatewayConfig> {
  let file: Partial<GatewayConfig> = {};
  try { file = await readPrivateJson<Partial<GatewayConfig>>(resolve(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const bridgeUrl = process.env.BRIDGE_URL ?? file.bridgeUrl ?? "";
  const bridgeToken = process.env.BRIDGE_TOKEN ?? file.bridgeToken ?? "";
  if (!bridgeUrl) throw new Error("BRIDGE_URL is required");
  const url = new URL(bridgeUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("BRIDGE_URL must use HTTPS (local development permits loopback HTTP)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Invalid BRIDGE_URL");
  if (!bridgeToken) throw new Error("BRIDGE_TOKEN is required");
  return {
    bridgeUrl: bridgeUrl.replace(/\/$/, ""), bridgeToken,
    sitesAccessToken: process.env.SITES_ACCESS_TOKEN ?? file.sitesAccessToken,
    runtimeDir: resolve(process.env.GATEWAY_RUNTIME_DIR ?? file.runtimeDir ?? ".runtime"),
    tickMs: bounded(file.tickMs, 1000, 250, 5000),
    qrRefreshLimit: bounded(file.qrRefreshLimit, 3, 0, 5),
    qrTimeoutMs: bounded(file.qrTimeoutMs, 300000, 1000, 600000),
    routeTag: process.env.ILINK_ROUTE_TAG ?? file.routeTag,
    ilinkVersion:process.env.ILINK_CLIENT_VERSION??file.ilinkVersion??'2.4.9',
  };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid gateway timing configuration");
  return value;
}
