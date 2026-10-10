import { join } from "node:path";
import type { GatewayAuth, ControlledParticipant, ControlledBinding, GatewayControlState } from "../shared/contracts.ts";
import type { BridgeClient } from "./bridge.ts";
import type { IlinkClient } from "./ilink.ts";

export type ParticipantControl = ControlledParticipant;
export type BindingControl = ControlledBinding;
export type GatewayControl = GatewayControlState;
export type ParticipantAuth = GatewayAuth & { participant_id: string };
export type BridgePort = Pick<BridgeClient, "post" | "uploadAttachment">;
export type IlinkPort = Pick<IlinkClient, "updates" | "send" | "getQr" | "qrStatus">;

export function privatePath(directory: string, category: string, id: string, filename: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid gateway identity");
  return join(directory, category, id, filename);
}
export function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
export function bindingActive(binding: BindingControl): boolean {
  return binding.expires_at > Date.now() && !["confirmed", "cancelled", "expired", "failed"].includes(binding.state);
}
