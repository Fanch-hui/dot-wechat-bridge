import type { GatewayAuth, GatewayJob, JobResult, ReplyJob } from "../shared/contracts.ts";
import { deliverWebhook } from "./callback.ts";
import { Journal } from "./storage.ts";
import { BridgeHttpError } from "./bridge.ts";
import { delay, type BridgePort } from "./multi-contracts.ts";
import type { ParticipantRuntime } from "./participant-runtime.ts";

export class JobDispatcher {
  private readonly active = new Map<string, Promise<void>>();
  private readonly chains = new Map<string, Promise<void>>();
  constructor(private readonly bridge: BridgePort, private readonly journal: Journal,
    private readonly auth: () => GatewayAuth, private readonly interval: number,
    private readonly participant: (id: string) => ParticipantRuntime | undefined,
    private readonly webhook = deliverWebhook, private readonly report: (message: string) => void = console.error) {}

  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          await this.recover(signal);
          const limit = Math.min(4, 16 - this.active.size);
          if (limit > 0) {
            const result = await this.bridge.post<{ jobs: GatewayJob[] }>("jobs", { ...this.auth(), limit }, signal);
            for (const job of result.jobs) await this.schedule(job, signal);
          }
        } catch { if (!signal.aborted) this.report("Gateway delivery unavailable; journal retained."); }
        await delay(this.interval, signal);
      }
    } finally { await Promise.allSettled(this.active.values()); }
  }
  private async recover(signal: AbortSignal): Promise<void> {
    for (const [id, record] of Object.entries(this.journal.data.jobs)) {
      if (this.active.has(id)) continue;
      if (!record.result) {
        const unknown = record.kind === "reply" && record.started !== false;
        record.result = { job_id: id, claim_token: record.claimToken, outcome: unknown ? "unknown" : "retryable",
          error_code: "gateway_interrupted", error_message: unknown ? "接入服务在发送过程中中断，未取得发送结果" : "接入服务中断，任务尚未完成" };
        await this.journal.save();
      }
      await this.ack(record.result, signal);
    }
  }
  private async ack(result: JobResult, signal: AbortSignal): Promise<void> {
    try { await this.bridge.post("complete", { ...this.auth(), ...result }, signal); }
    catch (error) {
      if (!(error instanceof BridgeHttpError && error.status === 409 && error.code === "job_claim_invalid")) throw error;
      // A reclaimed job belongs to its new claim; the old result cannot change it.
      this.report("Gateway job claim expired; server state retained.");
    }
    delete this.journal.data.jobs[result.job_id];
    await this.journal.save();
  }
  private async schedule(job: GatewayJob, signal: AbortSignal): Promise<void> {
    if (this.active.has(job.id) || this.journal.data.jobs[job.id]) return;
    const id = job.kind === "reply" ? (job as ReplyJob & { participant_id?: string }).participant_id ?? "personal" : "";
    this.journal.data.jobs[job.id] = { claimToken: job.claim_token, kind: job.kind, participantId: id, started: false };
    await this.journal.save();
    const before = job.kind === "reply" ? this.chains.get(id) ?? Promise.resolve() : Promise.resolve();
    const work = before.then(() => this.execute(job, id, signal)).catch(() => {
      if (!signal.aborted) this.report("Gateway acknowledgment unavailable; journal retained.");
    }).finally(() => {
      this.active.delete(job.id);
      if (this.chains.get(id) === work) this.chains.delete(id);
    });
    this.active.set(job.id, work);
    if (job.kind === "reply") this.chains.set(id, work);
  }
  private async execute(job: GatewayJob, id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const record = this.journal.data.jobs[job.id];
    const participant = job.kind === "reply" ? this.participant(id) : undefined;
    let result: JobResult;
    if (job.kind === "reply" && !participant) {
      result = { job_id: job.id, claim_token: job.claim_token, outcome: "retryable",
        error_code: "participant_unavailable", error_message: "成员已停用或微信连接尚未就绪" };
    } else {
      const started = async () => { record.started = true; await this.journal.save(); };
      if (job.kind === "webhook" || !job.payload.media) await started();
      result = job.kind === "webhook" ? await this.webhook(job) : await participant!.send(job, signal, started);
    }
    record.result = result;
    await this.journal.save();
    await this.ack(result, signal);
  }
}
