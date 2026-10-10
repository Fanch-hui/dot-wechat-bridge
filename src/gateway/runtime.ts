import type { GatewayAuth, GatewayLease, GatewayJob, JobResult } from "../shared/contracts.ts";
import { BridgeClient } from "./bridge.ts";
import { deliverWebhook } from "./callback.ts";
import type { GatewayConfig } from "./config.ts";
import { IlinkClient, IlinkError } from "./ilink.ts";
import { prepareInbound } from "./inbound.ts";
import { Journal, type Credentials } from "./storage.ts";

export interface RuntimeDependencies {
  bridge?: BridgeClient;
  ilink?: IlinkClient;
  webhook?: typeof deliverWebhook;
  report?: (message: string) => void;
}
export class GatewayRuntime {
  private readonly bridge: BridgeClient;
  private readonly ilink: IlinkClient;
  private readonly webhook: typeof deliverWebhook;
  private readonly report: (message: string) => void;
  private lease!: GatewayLease;
  private wechatStatus: "ok" | "credential_expired" | "error" = "ok";
  private readonly active = new Map<string, Promise<void>>();
  private replyChain = Promise.resolve();
  constructor(private readonly config: GatewayConfig, private readonly credentials: Credentials,
              private readonly journal: Journal, dependencies: RuntimeDependencies = {}) {
    this.bridge = dependencies.bridge ?? new BridgeClient(config);
    this.ilink = dependencies.ilink ?? new IlinkClient(credentials, config.routeTag,fetch,config.ilinkVersion);
    this.webhook = dependencies.webhook ?? deliverWebhook;
    this.report = dependencies.report ?? (message => console.error(message));
  }
  async run(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      this.lease = await this.bridge.post<GatewayLease>("lease", { gateway_id: this.journal.data.gatewayId }, combined);
      await Promise.all([this.pollLoop(combined), this.tickLoop(combined), this.jobsLoop(combined)]);
    } finally { controller.abort(); }
  }
  private auth(): GatewayAuth {
    if (Date.now() >= this.lease.lease_until) throw new Error("Gateway lease expired; restart after restoring Sites access");
    return { gateway_id: this.lease.gateway_id, lease_token: this.lease.lease_token };
  }
  private async tickLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const auth = this.auth();
      try {
        const tick = await this.bridge.post<{ lease_until: number }>("tick", auth, signal);
        this.lease.lease_until = tick.lease_until;
        await this.bridge.post("health", { ...auth, status: this.wechatStatus }, signal);
      } catch { if (!signal.aborted) this.report("Sites heartbeat unavailable; retrying within gateway lease."); }
      await delay(this.config.tickMs, signal);
    }
  }
  private async flushPending(signal: AbortSignal): Promise<void> {
    const pending = this.journal.data.pending;
    if (!pending) return;
    await this.bridge.post("ingest", { ...this.auth(), ...pending }, signal);
    this.lease.cursor = pending.cursor;
    delete this.journal.data.pending;
    await this.journal.save();
  }
  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.auth();
      if (this.wechatStatus === "credential_expired") { await delay(this.config.tickMs, signal); continue; }
      try {
        await this.flushPending(signal);
        const previous = this.lease.cursor;
        const response = await this.ilink.updates(previous, signal);
        if (signal.aborted) break;
        this.journal.data.pending = {
          previous_cursor: previous, cursor: response.get_updates_buf || previous,
          messages: await prepareInbound(response.msgs ?? [], this.credentials.userId, this.credentials.botId,
            this.bridge, () => this.auth(), signal),
        };
        await this.journal.save();
        await this.flushPending(signal);
        if (!this.wechatExpired()) this.wechatStatus = "ok";
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof IlinkError && error.code === "credential_expired") this.pauseWechat();
        else if ((error as Error).message === "bridge_http_409") throw new Error("Sites cursor conflict; pending batch retained for recovery");
        else { if (!this.wechatExpired()) this.wechatStatus = "error"; this.report("WeChat or Sites receive unavailable; persisted cursor retained."); }
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), signal);
      }
    }
  }
  private pauseWechat(): void {
    this.wechatStatus = "credential_expired";
    this.report("WeChat credentials expired; rebind and restart. MCP Events relay remains active.");
  }
  private wechatExpired(): boolean { return this.wechatStatus === "credential_expired"; }
  private async recoverJobs(signal: AbortSignal): Promise<void> {
    for (const [id, record] of Object.entries(this.journal.data.jobs)) {
      if (this.active.has(id)) continue;
      if (!record.result) {
        record.result = { job_id: id, claim_token: record.claimToken,
          outcome: record.kind === "reply" ? "unknown" : "retryable", error_code: "gateway_interrupted",
          error_message: record.kind === "reply" ? "接入服务在发送过程中中断，未取得发送结果" : "接入进程中断，事件将有限重试" };
        await this.journal.save();
      }
      await this.acknowledge(record.result, signal);
    }
  }
  private async acknowledge(result: JobResult, signal: AbortSignal): Promise<void> {
    await this.bridge.post("complete", { ...this.auth(), ...result }, signal);
    delete this.journal.data.jobs[result.job_id];
    await this.journal.save();
  }
  private async jobsLoop(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        this.auth();
        try {
          await this.recoverJobs(signal);
          const limit = Math.min(4, 8 - this.active.size);
          if (limit > 0) {
            const response = await this.bridge.post<{ jobs: GatewayJob[] }>("jobs", { ...this.auth(), limit }, signal);
            for (const job of response.jobs) this.scheduleJob(job, signal);
          }
        } catch { if (!signal.aborted) this.report("Gateway delivery or acknowledgment unavailable; journal retained."); }
        await delay(this.config.tickMs, signal);
      }
    } finally { await Promise.allSettled(this.active.values()); }
  }
  private scheduleJob(job: GatewayJob, signal: AbortSignal): void {
    if (this.active.has(job.id)) return;
    const work = job.kind === "reply" ? this.replyChain.then(() => this.executeJob(job, signal)) : this.executeJob(job, signal);
    const handled = work.catch(() => {
      if (!signal.aborted) this.report("Gateway delivery acknowledgment unavailable; journal retained.");
    }).finally(() => this.active.delete(job.id));
    this.active.set(job.id, handled);
    if (job.kind === "reply") this.replyChain = handled;
  }
  private async executeJob(job: GatewayJob, signal: AbortSignal): Promise<void> {
    if (this.journal.data.jobs[job.id]) return;
    this.journal.data.jobs[job.id] = { claimToken: job.claim_token, kind: job.kind };
    await this.journal.save();
    const result = job.kind === "webhook" ? await this.webhook(job) : await this.sendReply(job, signal);
    this.journal.data.jobs[job.id].result = result;
    await this.journal.save();
    await this.acknowledge(result, signal);
  }
  private async sendReply(job: Extract<GatewayJob, { kind: "reply" }>, signal: AbortSignal): Promise<JobResult> {
    const common = { job_id: job.id, claim_token: job.claim_token };
    if (this.wechatStatus === "credential_expired") return { ...common, outcome: "failed", error_code: "credential_expired", error_message: "微信凭据已过期，请重新扫码" };
    try {
      this.auth(); await this.ilink.send(job.payload, signal);
      return { ...common, outcome: "delivered" };
    } catch (error) {
      if (error instanceof IlinkError) {
        if (error.code === "credential_expired") this.pauseWechat();
        return { ...common, outcome: error.outcome, error_code: error.code, error_message: error.detail };
      }
      return { ...common, outcome: "unknown", error_code: "reply_interrupted", error_message: "发送被中断，结果未确认" };
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}
