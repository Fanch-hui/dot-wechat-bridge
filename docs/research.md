# 平台与协议参考

本项目通过 ChatGPT MCP 工具与事件连接已有 Dot；微信接入使用腾讯 ilink HTTP 协议。以下链接用于理解实现依据，部署时仍需核对平台实际权限和接口可用性。

## 托管与运行边界

[ChatGPT Sites](https://learn.chatgpt.com/docs/sites) 提供网站及服务托管。本项目要求私有 Worker、D1、R2、MCP 和 Secret 配置。部署者应在自己的项目中创建这些资源。

微信长轮询及事件回调由外部常驻 Node.js 进程负责。它也持续请求 Sites 的 tick/jobs，推动租约、唤醒和有限重试；进程停止后数据仍保存，但事件调度会暂停。[Cloudflare Workers 运行限制](https://developers.cloudflare.com/workers/platform/limits/)中的请求生命周期不能作为常驻进程的保证。

## MCP Events

实现依据 [OpenAI MCP Events 文档](https://developers.openai.com/plugins/build/mcp-events)、[MCP server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)、[工具协议](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)及[事件设计草案](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)。代码支持协议版本 `2026-07-28`，兼容 MCP 1.x 工具调用；事件使用 MCP 2.0 webhook。

- 实现 `events/list`、`events/subscribe` 和 `events/unsubscribe`；`wechat.message.available` 使用 `conversation=all` 覆盖所有成员，`personal` 仅覆盖旧单成员身份。
- 随机、单次、短时 challenge 验证成功后才启用订阅。
- 使用 Standard Webhooks HMAC 签名，包含 `webhook-id`、`webhook-timestamp`、`webhook-signature` 和 `X-MCP-Subscription-Id`。
- 回调仅接受公网 HTTPS，连接时校验 DNS 并固定目标地址，保留 TLS 主机校验，禁止重定向。原生 Worker `fetch` 无法直接提供此连接控制，因此由 Node 进程传输。
- 重试保留事件 ID，更新时间戳和签名；有限次数指数退避。HTTP 410 停用订阅，413 不重试。
- 订阅有有限期 `refreshBefore`；不保证永久订阅。回调 2xx 表示事件被接收，领取会话成功才表示有消费者开始处理。
- 不提供事件历史回放；微信消息独立持久化，订阅恢复后按成员恢复待处理会话。

平台是否支持事件订阅、持续等待、定期心跳和并行处理，须在部署者的真实 Dot 上按[人工验收](manual-acceptance.md)确认。

## 微信 ilink

协议参考腾讯维护的 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/tree/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c)，固定参考提交 `24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`。本项目直接实现必要 HTTP 接入，不要求安装 OpenClaw。

[API 实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/api/api.ts)和[扫码登录](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/auth/login-qr.ts)提供 `get_bot_qrcode`、`get_qrcode_status`、`getupdates`、`sendmessage`、Bot token、收件游标和回复上下文的实现参考。[协议阅读约定](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol_zh_CN.md#阅读约定)说明代码不能代表完整服务端契约；扫码准入、上下文有效期和发送条件以腾讯实际响应为准。

长轮询默认 35 秒；消息和游标按成员持久化后确认，uint64 消息 ID 保持字符串。每个成员只接受绑定发送者的私聊，过滤群消息和 Bot 回声。入站支持文本、已有语音转写、图片和文件，出站支持文本、图片和文件。

媒体参考[下载实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/media/media-download.ts)和 [AES 解密实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/cdn/aes-ecb.ts)。Node 下载、解密后将原始字节存到部署者的 R2；Dot 按成员通过附件工具读取，单个附件上限 20 MiB。图片返回 MCP 图片内容，文件使用 [MCP 嵌入资源](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#embedded-resources)返回原始字节。

[主动发送实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/channel.ts#L267-L279)和[文本发送函数](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/messaging/send.ts#L58-L126)使用收件人的最近上下文发送。主动工具沿用该行为，目标由明确成员 ID 决定；从未来信时可省略上下文尝试发送，是否接受以上游响应为准。

发送成功以上游响应为依据。超时显示“发送超时”；结果未知不自动重试，避免重复发送。测试证明实现的协议和状态变化，真实微信收件与 Dot 行为由部署者人工验收。

媒体发送依据腾讯提交 `c6643f6f0ac03574eb126f2d69569ea4267cc3c6` 的[上传实现](https://github.com/Tencent/openclaw-weixin/blob/c6643f6f0ac03574eb126f2d69569ea4267cc3c6/src/cdn/upload.ts)、[CDN 上传](https://github.com/Tencent/openclaw-weixin/blob/c6643f6f0ac03574eb126f2d69569ea4267cc3c6/src/cdn/cdn-upload.ts)及[发送函数](https://github.com/Tencent/openclaw-weixin/blob/c6643f6f0ac03574eb126f2d69569ea4267cc3c6/src/messaging/send.ts)。`getuploadurl` 使用原始长度、MD5 和 AES-128-ECB PKCS#7 密文长度，图片媒体类型为 1、文件为 3；CDN 成功须取得 `x-encrypted-param`。发送项中的 `aes_key` 是 hex ASCII 的 base64；图片 `mid_size` 使用密文长度，文件 `len` 是原始字节长度字符串。说明文字与媒体分开入队，避免一次调用部分成功。

出站来源可为公网 HTTPS 直链或最多 512 KiB 原始内容的 base64，总上限 20 MiB 是本项目限制。接入服务对下载地址执行连接时 DNS 校验和 pinning，拒绝私网与重定向；首次取得的 URL 字节存为不可变 R2 快照。媒体在 `preparing` 阶段续租并上传，开始发送前再校验成员和任务租约。发送准备失败可有限重试，实际消息发送结果未知不自动重发。腾讯没有承诺 `client_id` 提供严格的服务端去重，真实格式、账号准入和实际收件仍需人工验收。
