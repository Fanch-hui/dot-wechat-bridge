# dot-wechat-bridge

多个成员通过各自微信与同一个已有 OpenAI Dot 连续对话。Sites 托管私有成员管理网页、MCP、D1 消息队列、会话和订阅；一个 Node.js 接入服务负责多账号 ilink 长轮询及 MCP Events HTTPS 回调。

```text
微信 A ─┐
微信 B ─┼─ Node 多账号接入 ⇄ Sites / D1 ⇄ MCP 工具 ⇄ 同一个 Dot
微信 C ─┘                  └─ 私有成员管理网页
             └─ 签名 webhook → ChatGPT 事件回调
```

每个成员有稳定 ID 和所有者设置的称呼；来信、回复、附件和历史按成员归属。成员同等可信，默认按人读取历史，明确要求时允许跨人协作。同一个 Dot 的自身记忆可能共享，此功能不承诺严格隐私隔离。

接入不需要 OpenClaw、Redis 或独立消息数据库。双向支持文字、图片和文件；入站也支持上游已有的语音转写。附件原始字节存 Sites R2，由 Dot 自行读取，单个附件上限 20 MiB。

## 开始使用

使用方式是 **ChatGPT（GPT）Sites + 海外服务器，或一台能稳定连接外网的电脑**。Sites 托管网页、MCP 和数据；服务器或电脑持续运行微信接入程序。入门步骤和可复制的 GPT/Dot 指令见[使用指南](docs/getting-started.md)。

部署者需要自行提供私有 ChatGPT Sites 项目、该项目的 D1/R2 资源和一台持续运行的 Node.js 主机。所有地址和访问凭据都由部署者配置。

1. 按[部署说明](docs/deployment.md)配置并部署私有 Sites 项目，安装其插件。
2. 所有者在 ChatGPT 调用 `wechat_bridge_status`，登记管理身份；网页本身不登记管理员。
3. 启动唯一接入服务，将[Dot 指令](docs/dot-instructions.md)加入现有 Dot，订阅 `wechat.message.available`，过滤 `conversation=all`。
4. 用所有者账号打开 Site 首页，设置成员称呼并扫码连接，详见[微信绑定](docs/wechat-binding.md)。首次部署会生成待绑定的默认成员“我”，可先连接本人微信，再添加其他成员。从旧版本升级时，已有微信及历史自动归属原成员。
5. 按[人工验收指南](docs/manual-acceptance.md)验证真实微信、Dot 身份识别、唤醒及连续对话。

源码公开与服务访问范围分别管理：部署的 Site 应保持私有。部署成功以 Sites 返回为准；插件连接须以实际认证工具调用验证。

## 成员管理

私有 Site 首页提供成员列表、添加、改名、扫码、停用和恢复，显示连接状态、最近来信和发送异常。二维码可下载为 PNG，验证码在当前页面提交；过期后重新获取。重绑只能更新同一微信的凭据，另一人的微信应新增成员。重名时显示短 ID。

停用保留历史、待处理来信及发件任务，恢复后继续。已发送的结果保留。成员管理 API 每次校验所有者身份和同源请求，微信登录凭据仅保存在接入服务器。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `wechat_bridge_status` | 成员、接入、会话及发送异常状态 |
| `wechat_list_participants` | 取得可信成员 ID、称呼和状态 |
| `wechat_confirm_session` | 独有消费者领取事件对应成员的会话 |
| `wechat_read_messages` | 按顺序读取该会话成员的消息，结果携带成员身份 |
| `wechat_read_attachment` | 指定成员，读取原始图片或文件 |
| `wechat_send_reply` | 回复当前会话的来信，服务端推导收件人 |
| `wechat_send_message` | 指定成员主动发送文本，无需会话或来信 ID |
| `wechat_send_media` | 发送图片或文件，可按会话回复或明确指定成员主动发送 |
| `wechat_read_history` | 指定成员读取消息及全部回复上下文 |
| `wechat_heartbeat` | 延长当前会话处理租约 |
| `wechat_end_session` | 完成工作后结束空闲会话 |
| `wechat_recover_session` | 恢复指定成员已过期或唤醒失败的待处理会话 |
| `wechat_resolve_reply` | 经明确指示重试或跳过失败、结果未知的输出 |

历史、主动发送、恢复及附件读取支持 `participant_id`；仅成员记录总数为 1 时可省略。存在多个成员时，即使其他人停用或未绑定，也必须传目标 ID。普通回复由会话确定收件人，不能自行指定或混入其他成员的来信序号。

一条来信可多次独立回复：每次保留对应 `message_ids`，新输出用新 `idempotency_key`，重试原输出保持原 key、序号和正文。首次发送不结束会话，处理中每 30 秒心跳。主动发送与回复共用该成员的有序队列，历史以 `purpose: "send"` 标记。

发送超时展示“发送超时”，失败展示安全的具体原因。`delivered` 才表示已发送；`unknown` 不自动重发，须由用户检查微信收件后决定重试或跳过。异常只阻塞该成员的后续发送。

媒体工具使用 `kind: "image"` 或 `"file"`，提供文件名 `name`，以及公网 HTTPS 直链 `source_url` 或最多 512 KiB 原始内容的 `data_base64`，两种来源只能选一种。图片支持 PNG、JPEG、GIF、WebP，其他内容使用文件模式。Dot 生成文件后须交付真实字节或接入服务可下载的直链，`sandbox:` 链接和本机路径不能作为下载地址。

媒体与文字共用每个成员的有序队列。URL 内容首次取得后保存不可变快照，重试沿用原内容；说明文字单独发送。媒体要求协议 3 接入服务；旧服务继续收发文字，媒体调用返回明确的升级提示。`preparing` 表示准备或上传中，尚未发送微信消息；进入实际消息发送阶段后的未确认结果使用 `unknown`。

## 开发

需要 Node.js 22.13+。

```sh
npm ci
npm run check
npm test
npm run build
npm run dev
```

开发服务仅监听 `127.0.0.1:8787`，首页为管理网页，MCP 路径为 `/mcp`。本机测试身份头不能直接公开到公网。Worker 入口为 `dist/server/index.js`，接入入口为 `dist/gateway/main.js`。

自动化测试验证持久化、成员路由、租约、幂等、绑定及实际本机 HTTP/HTTPS 传输，微信与 Dot 行为由模拟客户端提供。真实微信和 Dot 行为及网页交互由用户手动验收。

## 源码结构

- `src/admin/`：私有成员管理网页。
- `src/core/`：成员、绑定、消息顺序、会话及发件队列。
- `src/events/`、`src/mcp/`：MCP 2.0 事件协议及工具接口。
- `src/gateway/`：多账号调度、扫码、微信 API、恢复日志及事件传输。
- `db/schema.ts`、`drizzle/`：数据库定义及增量迁移。
- `deployment/`：接入服务配置与服务范本。

Site 保持私有；运行目录持久保存扫码生成的凭据及恢复日志。不要将凭据、配置、聊天数据或运行目录上传到 Git 或聊天。

## 许可证

采用 MIT 许可证，详见 [LICENSE](LICENSE)。
