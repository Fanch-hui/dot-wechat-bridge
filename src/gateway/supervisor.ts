import { join } from "node:path";
import type { GatewayAuth, GatewayLease } from "../shared/contracts.ts";
import { BridgeClient } from "./bridge.ts";
import { IlinkClient } from "./ilink.ts";
import { Journal, atomicPrivateJson, readPrivateJson, type Credentials } from "./storage.ts";
import { BindingManager, type BoundCredentials } from "./binding-manager.ts";
import { ParticipantRuntime } from "./participant-runtime.ts";
import { JobDispatcher } from "./job-dispatcher.ts";
import { delay, privatePath, type BridgePort, type GatewayControl, type IlinkPort, type ParticipantControl } from "./multi-contracts.ts";
import type { GatewayConfig } from "./config.ts";
import type { deliverWebhook } from "./callback.ts";

interface ParticipantTask { runtime: ParticipantRuntime; controller: AbortController; work: Promise<void> }
export interface SupervisorDependencies {
  bridge?: BridgePort; ilink?: (credentials?: Credentials) => IlinkPort;
  webhook?: typeof deliverWebhook; report?: (message: string) => void;
}
export class GatewaySupervisor {
  private lease!: GatewayLease;
  private readonly bridge: BridgePort;
  private readonly ilink: (credentials?: Credentials) => IlinkPort;
  private readonly report: (message: string) => void;
  private readonly participants = new Map<string, ParticipantTask>();
  private readonly bindings: BindingManager;
  private readonly jobs: JobDispatcher;
  constructor(private readonly config: GatewayConfig, private readonly journal: Journal,
    dependencies: SupervisorDependencies = {}) {
    this.bridge = dependencies.bridge ?? new BridgeClient(config);
    this.ilink = dependencies.ilink ?? (credentials => new IlinkClient(credentials, config.routeTag, fetch, config.ilinkVersion));
    this.report = dependencies.report ?? (message => console.error(message));
    this.bindings = new BindingManager(config.runtimeDir, config.qrTimeoutMs, config.tickMs,
      this.bridge, () => this.auth(), () => this.ilink());
    this.jobs = new JobDispatcher(this.bridge, journal, () => this.auth(), config.tickMs,
      id => this.participants.get(id)?.runtime, dependencies.webhook, this.report);
  }
  private auth(): GatewayAuth {
    if (Date.now() >= this.lease.lease_until) throw new Error("Gateway lease expired; restore Sites access");
    return { gateway_id: this.lease.gateway_id, lease_token: this.lease.lease_token };
  }
  async run(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const legacy = await this.readCredentials(join(this.config.runtimeDir, "wechat-credentials.json"));
      if (legacy) await this.bridge.post("bind", { sender: legacy.userId, bot_id: legacy.botId }, combined);
      this.lease = await this.bridge.post<GatewayLease>("lease", {
        gateway_id: this.journal.data.gatewayId, protocol_version: 2 }, combined);
      await this.sync(combined);
      await Promise.all([this.tick(combined), this.jobs.run(combined)]);
    } finally {
      controller.abort();
      for (const task of this.participants.values()) task.controller.abort();
      await Promise.allSettled([...this.participants.values()].map(task => task.work));
      await this.bindings.stop();
    }
  }
  private async readCredentials(path: string): Promise<BoundCredentials | undefined> {
    try { return await readPrivateJson<BoundCredentials>(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async credentials(id: string, member: ParticipantControl): Promise<BoundCredentials | undefined> {
    if (member.binding_id) {
      const staged = await this.readCredentials(privatePath(this.config.runtimeDir, "participants", id, "binding-credentials.json"));
      if (staged?.bindingId === member.binding_id && staged.userId === member.sender && staged.botId === member.bot_id) {
        const path = privatePath(this.config.runtimeDir, "participants", id, "wechat-credentials.json");
        const current = await this.readCredentials(path);
        if (current?.bindingId !== staged.bindingId) await atomicPrivateJson(path, staged);
        return staged;
      }
    }
    const value = await this.readCredentials(privatePath(this.config.runtimeDir, "participants", id, "wechat-credentials.json"));
    if (value || id !== "personal") return value;
    return this.readCredentials(join(this.config.runtimeDir, "wechat-credentials.json"));
  }
  private async participantJournal(id: string): Promise<Journal> {
    const journal = await Journal.load(privatePath(this.config.runtimeDir, "participants", id, "gateway-journal.json"));
    if (id === "personal" && this.journal.data.pending) {
      if (journal.data.pending && JSON.stringify(journal.data.pending) !== JSON.stringify(this.journal.data.pending)) {
        throw new Error("Gateway pending journals conflict; retain recovery data");
      }
      journal.data.pending = this.journal.data.pending;
      await journal.save();
      delete this.journal.data.pending;
      await this.journal.save();
    }
    return journal;
  }
  private async sync(signal: AbortSignal): Promise<void> {
    const control = await this.bridge.post<GatewayControl>("control", this.auth(), signal);
    this.bindings.sync(control, signal);
    const valid = new Set(control.participants.filter(member => member.enabled && member.sender).map(member => member.id));
    for (const [id, task] of this.participants) {
      if (!valid.has(id)) { this.participants.delete(id); task.controller.abort(); await task.work; }
    }
    for (const member of control.participants) {
      if (!valid.has(member.id) || signal.aborted) continue;
      try {
        const credentials = await this.credentials(member.id, member);
        const current = this.participants.get(member.id);
        const matching = credentials && credentials.userId === member.sender && (!member.bot_id || credentials.botId === member.bot_id)
          && !control.bindings.some(binding => binding.id === credentials.bindingId && binding.state !== "confirmed");
        if (current && (!matching || current.runtime.credentials.botToken !== credentials.botToken)) {
          this.participants.delete(member.id); current.controller.abort(); await current.work;
        }
        if (!matching || this.participants.has(member.id)) continue;
        const journal = await this.participantJournal(member.id);
        const runtime = new ParticipantRuntime(member.id, credentials, member.cursor, journal, this.ilink(credentials), this.bridge,
          () => ({ ...this.auth(), participant_id: member.id }), this.config.tickMs);
        if (member.status === "credential_expired") runtime.status = "credential_expired";
        const controller = new AbortController();
        const work = runtime.poll(AbortSignal.any([signal, controller.signal])).catch(() => {
          runtime.status = "error"; this.report("Participant receiving unavailable; journal retained.");
        });
        this.participants.set(member.id, { runtime, controller, work });
      } catch { this.report("Participant credentials or recovery journal unavailable."); }
    }
  }
  private async tick(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const auth = this.auth();
      try {
        const result = await this.bridge.post<{ lease_until: number }>("tick", auth, signal);
        this.lease.lease_until = result.lease_until;
        await this.sync(signal);
        await this.bridge.post("health", { ...auth, status: "ok" }, signal);
        for (const [id, task] of this.participants) {
          await this.bridge.post("health", { ...auth, participant_id: id, status: task.runtime.status }, signal);
        }
      } catch { if (!signal.aborted) this.report("Sites heartbeat or control unavailable; retrying within gateway lease."); }
      await delay(this.config.tickMs, signal);
    }
  }
}
