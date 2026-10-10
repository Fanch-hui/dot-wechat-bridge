import { IlinkError, ILINK_BASE, trustedWechatBase } from "./ilink.ts";
import { atomicPrivateJson, readPrivateJson, type Credentials } from "./storage.ts";
import { bindingActive, delay, privatePath, type BindingControl, type BridgePort,
  type GatewayControl, type IlinkPort } from "./multi-contracts.ts";
import type { GatewayAuth } from "../shared/contracts.ts";

export interface BoundCredentials extends Credentials { bindingId?: string }
interface QrReceipt { qr: string; content: string; base: string; deadline: number }
export class BindingManager {
  private control: GatewayControl = { participants: [], bindings: [] };
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void> }>();
  constructor(private readonly directory: string, private readonly timeoutMs: number, private readonly interval: number,
    private readonly bridge: BridgePort, private readonly auth: () => GatewayAuth,
    private readonly client: () => IlinkPort) {}

  sync(control: GatewayControl, signal: AbortSignal): void {
    this.control = control;
    for (const [id, task] of this.active) {
      if (!control.bindings.some(binding => binding.id === id && bindingActive(binding))) task.controller.abort();
    }
    for (const binding of control.bindings) {
      if (!bindingActive(binding) || this.active.has(binding.id)) continue;
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      const work = this.run(binding, combined).catch(() => {}).finally(() => this.active.delete(binding.id));
      this.active.set(binding.id, { controller, work });
    }
  }
  async stop(): Promise<void> {
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map(task => task.work));
  }
  private current(id: string): BindingControl | undefined {
    return this.control.bindings.find(binding => binding.id === id && bindingActive(binding));
  }
  private report(id: string, state: string, fields: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    return this.bridge.post("binding", { ...this.auth(), id, state, ...fields }, signal);
  }
  private async saved(binding: BindingControl): Promise<BoundCredentials | undefined> {
    try {
      const value = await readPrivateJson<BoundCredentials>(privatePath(this.directory, "participants", binding.participant_id, "binding-credentials.json"));
      return value.bindingId === binding.id ? value : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async confirm(binding: BindingControl, credentials: BoundCredentials, signal: AbortSignal): Promise<void> {
    // Re-read authoritative request state after a long QR poll before persisting or activating it.
    const control = await this.bridge.post<GatewayControl>("control", this.auth(), signal);
    const request = control.bindings.find(item => item.id === binding.id);
    if (!request || !bindingActive(request) || signal.aborted) return;
    const member = control.participants.find(item => item.id === binding.participant_id);
    if (!member) return;
    if (member.sender && member.sender !== credentials.userId) {
      await this.report(binding.id, "failed", { error_code: "binding_identity_mismatch" }, signal); return;
    }
    if (control.participants.some(item => item.id !== member.id && item.sender === credentials.userId)) {
      await this.report(binding.id, "failed", { error_code: "binding_identity_duplicate" }, signal); return;
    }
    await atomicPrivateJson(privatePath(this.directory, "participants", member.id, "binding-credentials.json"), credentials);
    const result = await this.report(binding.id, "confirmed", { sender: credentials.userId, bot_id: credentials.botId }, signal) as { accepted?: boolean };
    if (result.accepted !== true || signal.aborted) return;
    await atomicPrivateJson(privatePath(this.directory, "participants", member.id, "wechat-credentials.json"), credentials);
    await this.bridge.post("health", { ...this.auth(), participant_id: member.id, status: "ok" }, signal);
  }
  private async qr(binding: BindingControl, client: IlinkPort, signal: AbortSignal): Promise<QrReceipt> {
    const path = privatePath(this.directory, "bindings", binding.id, "qr.json");
    try { return await readPrivateJson<QrReceipt>(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const response = await client.getQr(signal);
    if (!response.qrcode || !response.qrcode_img_content) throw new Error("binding_qr_incomplete");
    const receipt = { qr: response.qrcode, content: response.qrcode_img_content, base: ILINK_BASE,
      deadline: Math.min(binding.expires_at, Date.now() + this.timeoutMs) };
    await atomicPrivateJson(path, receipt);
    return receipt;
  }
  private async run(binding: BindingControl, signal: AbortSignal): Promise<void> {
    const client = this.client();
    let receipt: QrReceipt | undefined, reported = "";
    while (!signal.aborted && this.current(binding.id)) {
      try {
        const saved = await this.saved(binding);
        if (saved) { await this.confirm(binding, saved, signal); return; }
        receipt ??= await this.qr(binding, client, signal);
        if (Date.now() >= receipt.deadline) { await this.report(binding.id, "expired", {}, signal); return; }
        if (!reported) {
          await this.report(binding.id, "waiting", { qr_content: receipt.content }, signal); reported = "waiting";
        }
        const verify = this.current(binding.id)?.verification_code;
        const status = await client.qrStatus(receipt.base, receipt.qr, verify, signal);
        if (!this.current(binding.id) || signal.aborted) return;
        if (status.status === "confirmed") {
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id || !status.baseurl) {
            await this.report(binding.id, "failed", { error_code: "binding_confirmation_incomplete" }, signal); return;
          }
          await this.confirm(binding, { botToken: status.bot_token, botId: status.ilink_bot_id,
            userId: status.ilink_user_id, baseUrl: trustedWechatBase(status.baseurl), bindingId: binding.id }, signal);
          return;
        }
        if (["expired", "verify_code_blocked", "binded_redirect"].includes(status.status)) {
          await this.report(binding.id, status.status === "expired" ? "expired" : "failed",
            status.status === "expired" ? {} : { error_code: `binding_${status.status}` }, signal); return;
        }
        if (status.status === "scaned_but_redirect") {
          if (!status.redirect_host) throw new Error("binding_redirect_missing");
          receipt.base = trustedWechatBase(status.redirect_host);
          await atomicPrivateJson(privatePath(this.directory, "bindings", binding.id, "qr.json"), receipt);
        }
        const state = status.status === "need_verifycode" ? "need_verifycode"
          : ["scaned", "scaned_but_redirect"].includes(status.status) ? "scanned" : "waiting";
        if (state !== reported) { await this.report(binding.id, state, {}, signal); reported = state; }
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof IlinkError) && !(error as Error).message.startsWith("bridge_http_") &&
            (error as NodeJS.ErrnoException).code !== "ENOENT") {
          try { await this.report(binding.id, "failed", { error_code: "binding_failed" }, signal); return; } catch {}
        }
      }
      await delay(this.interval, signal);
    }
  }
}
