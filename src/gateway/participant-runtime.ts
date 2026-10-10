import type { JobResult, ReplyJob } from "../shared/contracts.ts";
import { prepareInbound } from "./inbound.ts";
import { IlinkError } from "./ilink.ts";
import { Journal, type Credentials } from "./storage.ts";
import { delay, type BridgePort, type IlinkPort, type ParticipantAuth } from "./multi-contracts.ts";
import { executeMediaJob } from "./media-job.ts";
import { OutboundMediaError } from "./outbound-media.ts";

export class ParticipantRuntime {
  status: "ok" | "credential_expired" | "error" = "ok";
  private conflict = false;
  private pollSignal?: AbortSignal;
  constructor(readonly id: string, readonly credentials: Credentials, private cursor: string,
    readonly journal: Journal, readonly ilink: IlinkPort, private readonly bridge: BridgePort,
    private readonly auth: () => ParticipantAuth, private readonly interval: number) {}

  async poll(signal: AbortSignal): Promise<void> {
    this.pollSignal = signal;
    let failures = 0;
    while (!signal.aborted) {
      if (this.status === "credential_expired" || this.conflict) { await delay(this.interval, signal); continue; }
      try {
        await this.flush(signal);
        const previous = this.cursor;
        const update = await this.ilink.updates(previous, signal);
        if (signal.aborted) break;
        this.journal.data.pending = { previous_cursor: previous, cursor: update.get_updates_buf || previous,
          messages: await prepareInbound(update.msgs ?? [], this.credentials.userId, this.credentials.botId,
            this.bridge, this.auth, signal) };
        await this.journal.save();
        if (signal.aborted) break;
        await this.flush(signal);
        if (!this.expired()) this.status = "ok";
        failures = 0;
        await delay(10, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof IlinkError && error.code === "credential_expired") this.status = "credential_expired";
        else {
          if (!this.expired()) this.status = "error";
          if ((error as Error).message === "bridge_http_409") this.conflict = true;
        }
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), signal);
      }
    }
  }
  private expired(): boolean { return this.status === "credential_expired"; }
  private async flush(signal: AbortSignal): Promise<void> {
    const pending = this.journal.data.pending;
    if (!pending || signal.aborted) return;
    await this.bridge.post("ingest", { ...this.auth(), ...pending }, signal);
    this.cursor = pending.cursor;
    delete this.journal.data.pending;
    await this.journal.save();
  }
  async send(job: ReplyJob, signal: AbortSignal, markStarted: () => Promise<void> = async () => {}): Promise<JobResult> {
    const common = { job_id: job.id, claim_token: job.claim_token };
    if (this.expired()) return { ...common, outcome: "failed", error_code: "credential_expired", error_message: "微信凭据已过期，请重新扫码" };
    let sending = !job.payload.media;
    const combined = this.pollSignal ? AbortSignal.any([signal, this.pollSignal]) : signal;
    try {
      this.auth();
      if (job.payload.media) {
        await executeMediaJob(job, this.bridge, this.auth, combined, markStarted, (bytes, preparedSignal, beforeSend) =>
          this.ilink.send(job.payload, preparedSignal, { mediaBytes: bytes, beforeSend: async () => {
            await beforeSend(); sending = true;
          } }));
      } else await this.ilink.send(job.payload, combined);
      return { ...common, outcome: "delivered" };
    } catch (error) {
      if (error instanceof OutboundMediaError) return { ...common, outcome: error.outcome, error_code: error.code, error_message: error.detail };
      if (error instanceof IlinkError) {
        if (error.code === "credential_expired") this.status = "credential_expired";
        return { ...common, outcome: error.outcome, error_code: error.code, error_message: error.detail };
      }
      return { ...common, outcome: sending ? "unknown" : "retryable", error_code: "reply_interrupted",
        error_message: sending ? "发送被中断，结果未确认" : "附件准备中断，尚未发送" };
    }
  }
}
