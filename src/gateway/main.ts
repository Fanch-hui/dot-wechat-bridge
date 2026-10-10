import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { BridgeClient } from "./bridge.ts";
import { IlinkClient } from "./ilink.ts";
import { bindWechat } from "./bind.ts";
import { atomicPrivateJson, Journal } from "./storage.ts";
import { GatewaySupervisor } from "./supervisor.ts";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "bind" && command !== "run") throw new Error("Usage: npm run gateway -- bind|run [config-file]");
  const config = await loadConfig(process.argv[3]);
  const credentialsPath = join(config.runtimeDir, "wechat-credentials.json");
  if (command === "bind") {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const credentials = await bindWechat(new IlinkClient(undefined, config.routeTag,fetch,config.ilinkVersion), {
        refreshLimit: config.qrRefreshLimit, timeoutMs: config.qrTimeoutMs,
        displayQr: url => console.log(`请在本人微信中打开或扫描以下二维码链接：\n${url}`),
        verificationCode: () => reader.question("请输入手机微信显示的数字："),
      });
      await atomicPrivateJson(credentialsPath, credentials);
      await new BridgeClient(config).post("bind", { sender: credentials.userId, bot_id: credentials.botId });
      console.log("本人微信已绑定；凭据已安全保存。使用 run 启动桥接。");
    } finally { reader.close(); }
    return;
  }
  const journal = await Journal.load(join(config.runtimeDir, "gateway-journal.json"));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  console.log("微信桥接和 MCP Events relay 已启动。");
  await new GatewaySupervisor(config, journal).run(controller.signal);
}

main().catch(error => {
  // Response bodies and credentials never become log messages.
  const message = error instanceof Error ? error.message : "Gateway failed";
  console.error(message.startsWith("bridge_http_") || /^(Usage:|Invalid|BRIDGE_|WeChat |微信|Sites |Gateway |Untrusted)/.test(message)
    ? message : "Gateway failed; check configuration and connectivity.");
  process.exitCode = 1;
});
