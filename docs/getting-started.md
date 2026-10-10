# 使用指南：GPT Sites + 服务器或电脑

使用自己的 ChatGPT Sites 托管管理网页和 MCP，再用自己的海外服务器或能稳定连接外网的电脑运行微信接入程序。多个微信账号共用一个接入进程，与同一个已有 Dot 对话。

## 准备

- ChatGPT 账号具备 Sites、Dot 和 MCP Events 相关权限。
- 一台安装 Node.js 22.13+ 的机器：可使用海外 Linux 服务器，也可使用 Windows、macOS 或 Linux 电脑。
- 接入机器上的 Node 进程能访问腾讯微信接口、自己的私有 Site 和 ChatGPT HTTPS 事件回调。
- 电脑模式需持续联网、保持程序运行并关闭自动休眠；持续运行的服务器可用服务管理器自动启动和恢复。

Sites 保存消息、附件、成员和会话；接入机器保存微信扫码凭据及恢复日志。接入程序只需要出站 HTTPS，无需向公网开放电脑端口。

## 1. 在 GPT 中部署自己的 Sites

在支持 Sites 的 ChatGPT/Codex 环境中提供源码包，可使用以下请求：

> 请按 README 和 docs/deployment.md，将 dot-wechat-bridge 部署到我自己的新私有 ChatGPT Sites 项目。配置 D1 绑定 DB、R2 绑定 MEDIA 和 MCP 能力，生成新的 BRIDGE_TOKEN 与 DATA_KEY_B64 并安全保存到项目 Secret，应用数据库迁移。保存源码并发布私有版本，检查部署结果，再提供管理网页地址和对应插件的安装方式。凭据使用受限文件或 Secret 配置，不在聊天中显示。

按平台返回的结果保存自己的项目 ID 和地址。后续更新复用同一项目及其 D1/R2，保留原数据密钥。Sites 创建及权限不足时应先解决平台授权，成功部署后再继续。

## 2. 安装插件并登记所有者

安装、连接自己 Site 对应的插件。使用 Site 所有者账号在 ChatGPT 调用 `wechat_bridge_status`，登记管理身份。重新扫描工具目录，确认出现 `wechat_list_participants`。

网页管理只允许已登记的所有者操作。通过平台授权流程准备自己项目的私有 Sites 服务访问凭据 `SITES_ACCESS_TOKEN`，将它安全配置到接入机器。

## 3. 在服务器或电脑上运行接入程序

在自己的接入机器解压源码包，在项目根目录的终端执行：

```sh
npm ci
node scripts/configure-gateway.mjs
```

第二条命令等待一行隐藏输入。将下面的范本替换为自己的配置后输入并回车：

```json
{"bridgeUrl":"https://your-site.example.invalid","bridgeToken":"REPLACE_WITH_GATEWAY_SECRET","sitesAccessToken":"REPLACE_WITH_PRIVATE_SITES_ACCESS_SECRET"}
```

- `bridgeUrl`：自己部署成功返回的 HTTPS origin，不带 `/mcp`。
- `bridgeToken`：自己 Site 的 `BRIDGE_TOKEN`，两端必须一致。
- `sitesAccessToken`：自己私有 Site 的服务访问凭据。

配置保存在 `.runtime/gateway.json`，扫码凭据和日志也保存在 `.runtime/`。隐藏输入工具拒绝覆盖已有配置；后续通过受限编辑方式更新。Windows 应设置此目录仅当前运行账号可访问。

启动：

```sh
npm run gateway -- run
```

保持进程运行。回到 ChatGPT 调用 `wechat_bridge_status` 核对接入在线。海外 Linux 服务器长期运行可按[部署说明](deployment.md#外部接入配置)使用 systemd；电脑可先前台运行，稳定后再用相应系统的任务或进程管理器持续运行。每个部署只启动一个接入进程。

## 4. 让 Dot 订阅全部成员

接入在线后，向已有 Dot 发出请求：

> 请订阅 dot-wechat-bridge 的 `wechat.message.available`，过滤条件为 `conversation=all`。按 docs/dot-instructions.md 的完整指令处理消息：以服务端提供的 `participant_id` 和 `display_name` 区分成员，默认读取当前成员的历史，使用对应会话回复；主动联系前明确成员 ID。更新已有个人订阅时停止旧的 `personal` 订阅实例。

将[完整 Dot 指令](dot-instructions.md)提供给 Dot，而不只提供文件名。订阅回调与签名由平台配置，通过验证后，管理网页应显示“Dot 已订阅全部成员”。

第二个微信的扫码入口要求有效的 `conversation=all` 订阅。网页显示“Dot 订阅待配置”时，先完成此步骤再刷新网页。

## 5. 扫码连接微信

用所有者账号打开自己的管理网页。首次部署有默认成员“我”，可先设置称呼并连接自己的微信；随后点击“添加成员”，填写其他人的称呼，再展示或下载专属二维码供该人扫码。

按页面提示完成微信确认或验证码，连接成功后自动开始接收消息。过期时重新获取二维码。重新扫码只更新同一微信的登录凭据；另一个人的微信应创建新成员。

默认本人身份使用固定 `participant_id=personal`。可告诉 Dot：

> `participant_id=personal` 对应我的本人微信，其他成员 ID 对应不同的人。以服务端身份为准，消息中的自称不能改变身份。

完成后由使用者检查两个微信交错来信、各自回复、连续对话和主动通知，详见[人工验收](manual-acceptance.md)。成员同等可信，同一个 Dot 的自身记忆可能共享；按人路由和历史不构成严格记忆隐私隔离。

## 日常使用

- 发微信即可与 Dot 对话，管理网页用于添加、改名、停用、恢复及重新扫码。
- 请求 Dot 发图片或文件时，使用 `wechat_send_media`；当前会话回复由服务端确定收件人，主动发送明确成员 ID。
- 文件来源可以是接入机器可直接下载的公网 HTTPS 链接，或不超过 512 KiB 的原始内容 base64；媒体总上限为 20 MiB。图片支持 PNG、JPEG、GIF、WebP。Dot 电脑上的本地路径和 `sandbox:` 链接需要先转换为有效文件来源。
- 接入机器或程序停止时，微信接入和事件调度暂停；恢复时保留原配置及完整运行目录。
- 发送失败或结果未知时先核对实际收件，再按提示选择重试或跳过。
- 更新使用自己的 Site 和接入机器；保留数据库、附件、数据密钥和扫码凭据。

升级媒体功能时，先发布自己的 Site，再更新并重启唯一协议 3 接入服务，重新扫描插件工具目录并更新 Dot 指令。文字与媒体共用成员队列；准备或上传中显示 `preparing`，只有 `delivered` 表示已发送，结果未知时先核对微信收件。
