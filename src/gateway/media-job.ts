import { createHash } from "node:crypto";
import type { GatewayAuth, ReplyJob, StoredMedia } from "../shared/contracts.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/contracts.ts";
import type { BridgePort } from "./multi-contracts.ts";
import { downloadPublicMedia } from "./media-source.ts";
import { OutboundMediaError } from "./outbound-media.ts";

interface MediaJobOptions { heartbeatMs?: number; download?: typeof downloadPublicMedia }
export async function executeMediaJob(job: ReplyJob, bridge: BridgePort, auth: () => GatewayAuth, signal: AbortSignal,
  markStarted: () => Promise<void>, send: (bytes: Uint8Array, signal: AbortSignal, beforeSend: () => Promise<void>) => Promise<void>,
  options: MediaJobOptions = {}): Promise<void> {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const claim = () => ({ ...auth(), job_id: job.id, claim_token: job.claim_token });
  let heartbeat: Promise<void> = Promise.resolve(), heartbeatError: unknown;
  let busy = false;
  const renew = async () => {
    await bridge.post("job-heartbeat", claim(), combined);
  };
  await renew();
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    heartbeat = renew().catch(error => { heartbeatError = error; controller.abort(); }).finally(() => { busy = false; });
  }, options.heartbeatMs ?? 5000);
  const stopHeartbeat = async () => {
    clearInterval(timer); await heartbeat;
    if (heartbeatError) throw heartbeatError;
    combined.throwIfAborted();
  };
  try {
    const bytes = await mediaBytes(job, bridge, claim, combined, options.download ?? downloadPublicMedia);
    await send(bytes, combined, async () => {
      await stopHeartbeat();
      await markStarted();
      await bridge.post("start-send", claim(), combined);
      combined.throwIfAborted();
    });
  } finally { clearInterval(timer); await heartbeat; }
}

async function mediaBytes(job: ReplyJob, bridge: BridgePort,
  auth: () => GatewayAuth & { job_id: string; claim_token: string }, signal: AbortSignal,
  download: typeof downloadPublicMedia): Promise<Uint8Array> {
  const media = job.payload.media!;
  const stored = media.cached ?? (media.source.type === "stored" ? media.source : undefined);
  let bytes: Uint8Array;
  if (stored) {
    if (!bridge.downloadMedia) throw new OutboundMediaError("media_storage_unavailable", "failed", "附件存储接口不可用");
    bytes = await bridge.downloadMedia(auth(), signal);
    verifySnapshot(bytes, stored);
  } else {
    if (media.source.type !== "url" || !bridge.cacheMedia) throw new OutboundMediaError("media_storage_unavailable", "failed", "附件存储接口不可用");
    bytes = await download(media.source.url, signal);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new OutboundMediaError("media_too_large", "failed", "附件超过大小限制");
    const cached = await bridge.cacheMedia(auth(), bytes, signal);
    verifySnapshot(bytes, cached);
    media.cached = cached;
  }
  if (media.kind === "image" && !imageBytes(bytes)) throw new OutboundMediaError("media_image_invalid", "failed", "附件内容不是支持的图片格式");
  return bytes;
}
function verifySnapshot(bytes: Uint8Array, snapshot: StoredMedia): void {
  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.length !== snapshot.size ||
      createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
    throw new OutboundMediaError("media_snapshot_mismatch", "failed", "附件快照校验失败");
  }
}
function imageBytes(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes);
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (data[0] === 255 && data[1] === 216 && data[2] === 255) ||
    ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")) ||
    (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP");
}
