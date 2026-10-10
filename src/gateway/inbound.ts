import type { GatewayAuth, IncomingAttachment, IncomingMessage } from "../shared/contracts.ts";
import type { BridgePort } from "./multi-contracts.ts";
import { inboundMessages, personalMessages, type MessageItem, type WechatMessage } from "./ilink.ts";
import { downloadMediaFromItem, MediaDownloadError } from "./media.ts";

function attachmentName(item: MessageItem): string {
  if (item.type === 2) return "image";
  return (item.file_item?.file_name ?? "file").replace(/\\/g, "/").split("/").at(-1)!
    .replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) || "file";
}

export async function prepareInbound(messages: WechatMessage[], owner: string, bot: string,
  bridge: BridgePort, auth: () => GatewayAuth, signal: AbortSignal,
  download = downloadMediaFromItem): Promise<IncomingMessage[]> {
  const result: IncomingMessage[] = [];
  for (const raw of personalMessages(messages, owner, bot)) {
    const [message] = inboundMessages([raw], owner, bot);
    const attachments: IncomingAttachment[] = [];
    for (const [index, item] of (raw.item_list ?? []).entries()) {
      if (item.type !== 2 && item.type !== 4) continue;
      let media;
      try { media = await download(item, { signal }); }
      catch (error) {
        if (signal.aborted) throw error;
        const failure = error instanceof MediaDownloadError ? error : new MediaDownloadError("media_download_failed", "微信附件下载失败");
        attachments.push({ item_index: index, kind: item.type === 2 ? "image" : "file", name: attachmentName(item),
          status: "failed", error_code: failure.code, error_message: failure.detail });
        continue;
      }
      if (!media) continue;
      // A failed upload leaves the upstream cursor unchanged for a safe retry.
      attachments.push(await bridge.uploadAttachment(auth(), { upstream_id: message.upstream_id,
        item_index: index, kind: media.kind, name: media.name, mime_type: media.mime_type }, media.data, signal));
    }
    if (attachments.length) {
      message.attachments = attachments;
      message.kind = "media";
      const hasText = (raw.item_list ?? []).some(item => item.text_item?.text || item.voice_item?.text);
      if (!hasText) message.text = attachments.map(item => item.kind === "image" ? "[微信图片]" : `[微信文件：${item.name}]`).join("\n");
    }
    result.push(message);
  }
  return result;
}
