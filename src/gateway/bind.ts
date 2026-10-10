import { IlinkClient, ILINK_BASE, trustedWechatBase } from "./ilink.ts";
import type { Credentials } from "./storage.ts";

export interface BindOptions {
  refreshLimit: number; timeoutMs: number;
  displayQr: (url: string) => void;
  verificationCode: () => Promise<string>;
}
export async function bindWechat(client: IlinkClient, options: BindOptions): Promise<Credentials> {
  const deadline = Date.now() + options.timeoutMs;
  let refreshes = 0, qr = "", base = ILINK_BASE, verify: string | undefined;
  while (Date.now() < deadline) {
    if (!qr) {
      const response = await client.getQr();
      if (!response.qrcode || !response.qrcode_img_content) throw new Error("WeChat returned an incomplete QR code");
      qr = response.qrcode; options.displayQr(response.qrcode_img_content);
    }
    const status = await client.qrStatus(base, qr, verify);
    switch (status.status) {
      case "confirmed":
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id || !status.baseurl) {
          throw new Error("WeChat confirmation is missing required binding fields");
        }
        return { botToken: status.bot_token, botId: status.ilink_bot_id,
          userId: status.ilink_user_id, baseUrl: trustedWechatBase(status.baseurl) };
      case "need_verifycode":
        verify = (await options.verificationCode()).trim();
        if (!/^\d{1,12}$/.test(verify)) throw new Error("Invalid verification code");
        continue;
      case "expired": case "verify_code_blocked":
        if (++refreshes > options.refreshLimit) throw new Error("WeChat QR refresh limit reached");
        qr = ""; base = ILINK_BASE; verify = undefined; continue;
      case "scaned_but_redirect":
        if (!status.redirect_host) throw new Error("WeChat redirect host missing");
        base = trustedWechatBase(status.redirect_host); break;
      case "binded_redirect": throw new Error("WeChat reports an existing binding; retain its credentials or rebind from WeChat");
      case "scaned": verify = undefined; break;
      case "wait": break;
      default: throw new Error("Unexpected WeChat QR status");
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("WeChat binding timed out");
}
