# 部署、安装与配置

部署者需拥有 ChatGPT Sites 创建/发布及 MCP Events/Dot 使用权限，自行创建私有 Site、D1/R2 资源，并准备可持续出站访问腾讯和 ChatGPT HTTPS 的 Node.js 22.13+ 主机。微信账号需满足上游扫码接入条件。本项目不需要 OpenAI API key；与 Dot 的交互通过平台 MCP 工具和事件完成。

项目使用部署者自己的云资源、主机及凭据。发布源码不提供托管服务，也不提供共享微信账号。Sites 和微信的接口可用性以部署时平台实际支持及账号权限为准。

## Sites 部署

1. 安装依赖并验证源码：

   ```sh
   npm ci
   npm run check
   npm test
   ```

2. 在自己的 ChatGPT Sites 工作区创建新的私有项目。按发布工具返回的项目 ID 配置 `.openai/hosting.json`，保留 D1 逻辑绑定 `DB`、R2 逻辑绑定 `MEDIA` 及 `mcp` 能力。数据库和存储由该项目提供。实际 origin 使用成功部署返回的 HTTPS 地址；不要使用范本中的占位地址。之后的升级复用自己项目的 ID、数据库和私有访问范围。

3. 生成本项目的新 Secret，保存到本机受限文件，不输出到终端或聊天：

   ```sh
   mkdir -p .runtime
   chmod 700 .runtime
   node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(".runtime/sites-secrets.json", JSON.stringify({BRIDGE_TOKEN:randomBytes(32).toString("base64"), DATA_KEY_B64:randomBytes(32).toString("base64")}), {mode:0o600,flag:"wx"});'
   ```

   通过 Sites Secret 管理将这两个值配置到该项目。`BRIDGE_TOKEN` 授权外部接入；`DATA_KEY_B64` 必须是 32 随机字节的标准 base64，用于加密微信回复上下文、事件签名 secret 和任务 payload。后续部署保留原数据密钥，否则已有密文无法解密。上述命令拒绝覆盖已有文件。

4. 可选时限见根目录 `.env.example`。按 Sites 工具实际支持的运行配置方式设置，Secret 不写入 manifest。D1 迁移使用已提交的 `drizzle/*.sql`；更改 schema 时先运行 `npm run db:generate`，已有迁移不可改写，业务请求不建表。

5. 配置完成后运行 `npm run build`。在拥有该项目访问权的 Sites 发布环境中初始化自己的 Git 仓库并提交源码。使用平台源码/归档流程保存提交，然后发布私有版本。若使用 Sites 插件的 `site-workflow.mjs`，通过受限输入传递源码凭据，取得归档和 commit SHA 后以返回原值调用 `save_version_and_deploy_private`，或先 `save_site_version` 再 `deploy_private_site_version`。具体工具名称和输入以本机 Sites 插件版本为准。构建输出 `dist/server/index.js` 和 `dist/.openai/hosting.json` 是 Worker 部署入口；不要把发布凭据放入命令参数、源码或归档。

6. 检查 `get_deployment_status` 的 `succeeded` 和实际 URL。登记、源码保存及本机构建均不是部署成功证据。发布环境应确认迁移随版本应用，再进行实际插件工具调用。

项目首次默认保持私有。首页 `/` 是成员管理网页，操作通过同源 `/api/admin/`；每次请求校验已登记的所有者身份。`/health` 只能说明服务和基本配置；有效用户的 `wechat_bridge_status` 才能验证已认证 MCP 调用及数据库读取。

## 安装 Sites 插件

Sites 为项目提供 App 和私有插件，复用它们，不另建 App。部署后调用 `get_site` 并设置 `include_mcp_connection:true`，从返回结果取得插件 ID；使用插件管理的安装建议，或在 ChatGPT **Plugins → Personal → Created by you** 打开对应插件并选择 Install/Connect。

在 ChatGPT 中授权后，部署者以 Site 所有者账号首次调用 `wechat_bridge_status`，登记项目管理身份。首次调用应在只授权该所有者的私有范围内完成。管理网页不自动登记管理员；人员管理仅供该所有者使用。工具请求由 Sites OAuth 和可信 `oai-authenticated-user-id` 标识用户；外部接入 Secret 不代替 MCP 用户身份。不要公开 Site 来绕过授权失败。

重新扫描工具目录，确认 `wechat_list_participants` 及支持 `participant_id` 的工具可用。更新 [Dot 指令](dot-instructions.md)，订阅 `wechat.message.available` 的 `conversation=all`；停止旧 `personal` 订阅实例，避免重复唤醒。第二个微信扫码或恢复启用前要求有效 all 订阅。

## 外部接入配置

按[微信绑定](wechat-binding.md)准备配置、扫码和启动。配置范本为 `deployment/gateway.config.example.json` 与 `deployment/gateway.env.example`。环境变量优先于同用途 JSON 字段。`.env.example` 是配置清单，程序不会自动加载 `.env`；通过服务管理器注入环境变量，或使用受限 JSON 配置文件。

| 配置 | 范围与作用 |
| --- | --- |
| `BRIDGE_URL` / `bridgeUrl` | 成功部署的 HTTPS origin，不含 `/mcp` |
| `BRIDGE_TOKEN` / `bridgeToken` | 与 Sites 中新建 Secret 一致，仅接入授权 |
| `SITES_ACCESS_TOKEN` / `sitesAccessToken` | 私有 Sites 访问凭据，发送 `OAI-Sites-Authorization: Bearer …`，支持填写原始 token 或带 Bearer 前缀的值 |
| `GATEWAY_RUNTIME_DIR` / `runtimeDir` | 持久运行目录，默认 `.runtime` |
| `ILINK_ROUTE_TAG` / `routeTag` | 可选腾讯路由标签 |
| `ILINK_CLIENT_VERSION` / `ilinkVersion` | ilink 客户端协议版本，默认采用已核实的腾讯 `2.4.9` |
| `tickMs` | JSON 配置，默认 1000，范围 250–5000 ms |
| `qrRefreshLimit` | JSON 配置，默认 3，范围 0–5 |
| `qrTimeoutMs` | JSON 配置，默认 300000，范围 1000–600000 ms |

私有 Sites 访问凭据由平台授权流程取得并安全注入，不要求用户在聊天中提供。接入不读取原有微信账号数据，新的 Bot 凭据由用户扫码产生。可信身份头必须由 Sites 的认证层提供。本机开发允许 identity header 仅用于环回测试，不能直接暴露到公网，也不能让浏览器自行设置这个头作为身份依据。若迁移到其他托管平台，必须先提供等价的可信认证转发；仅更换 Worker 地址并不足以安全运行。

本机配置/凭据/恢复日志权限 `0600`，运行目录 `0700`；恢复日志包含尚未提交的收件内容，应按私人聊天数据保护。

所有成员共用一个持续运行的协议 2 Node 接入服务和全局网关租约。进程无需入站端口，仅出站 HTTPS；每人独立轮询、游标、恢复日志及发送队列，共用 Sites 心跳和事件回调。暂停它将暂停全部微信接入、订阅验证及事件发送。服务可以在尚无微信绑定时启动，随后通过私有首页逐人扫码。

Linux 使用 `deployment/gateway.service.example`，在自己管理的主机上安装。构建后将 `dist/gateway/main.js` 安装为 `/opt/dot-wechat-bridge/main.mjs`，项目专用 Node.js 安装在 `/opt/dot-wechat-bridge/node/`，按真实路径调整单元。编译接入仅依赖 Node 内置模块，运行时无需 npm 或 `node_modules`。使用专用 `dot-wechat` 用户及组；JSON 配置放在 `/etc/dot-wechat-bridge/gateway.json`，由该用户拥有且权限为 `0600`；环境文件 `/etc/dot-wechat-bridge/gateway.env` 由 root 拥有且权限为 `0600`。程序读取 JSON 时会设置 `0600`，因此单元对该配置文件单独开放写权限。运行目录固定为 `/var/lib/dot-wechat-bridge`，由服务用户拥有且权限为 `0700`；环境文件中的 `GATEWAY_RUNTIME_DIR` 如存在，也应使用此路径。

在自己的 Linux 主机上，以管理员执行以下安装步骤。先确保 Node.js 22.13+ 已安装到服务单元所写的路径；使用系统 Node 时相应调整 `ExecStart`。以下源文件路径相对源码目录，文件内的占位值需替换为自己的部署配置。

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin dot-wechat
sudo install -d -m 0755 /opt/dot-wechat-bridge
sudo install -d -m 0750 -o root -g dot-wechat /etc/dot-wechat-bridge
sudo install -d -m 0700 -o dot-wechat -g dot-wechat /var/lib/dot-wechat-bridge
sudo install -m 0644 dist/gateway/main.js /opt/dot-wechat-bridge/main.mjs
sudo install -m 0600 -o dot-wechat -g dot-wechat deployment/gateway.config.example.json /etc/dot-wechat-bridge/gateway.json
sudo install -m 0600 deployment/gateway.env.example /etc/dot-wechat-bridge/gateway.env
sudo install -m 0644 deployment/gateway.service.example /etc/systemd/system/dot-wechat-bridge.service
```

通过受限编辑方式填写 `gateway.env` 中自己的 Site origin、接入 Secret 和私有 Sites 访问凭据，再启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dot-wechat-bridge.service
sudo systemctl status dot-wechat-bridge.service
```

仅有服务 `active` 不证明云端认证已通过；随后在 ChatGPT 调用 `wechat_bridge_status` 核对接入在线，再配置 all 订阅并扫码。每个部署只启动一个接入服务。

迁移接入主机时，先停止旧进程并等其退出，再安全转移完整运行目录，包括原 `wechat-credentials.json`、`gateway-journal.json` 及 `participants/`、`bindings/`。文件交给服务用户拥有并设为 `0600`，目录为 `0700`。保留全局 journal 的 `gatewayId` 可立即取得新租约；使用新 ID 时等待旧租约过期，默认 90 秒。只启动一个接入服务，不能按成员启动多个全局服务。

macOS 使用 launchd 或已有进程管理器执行 `npm run gateway -- run /etc/dot-wechat-bridge/gateway.json`，设置正确 `WorkingDirectory` 与环境、`KeepAlive`，确保运行目录持久且仅本人可读。Docker 如用于部署环境，保留 `.runtime` 持久卷并以非 root 用户运行相同命令，不引入额外数据库或队列。

## 默认时限

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `SESSION_LEASE_MS` | 90000 | Dot 处理租约；建议 30 秒心跳 |
| `SESSION_IDLE_MS` | 120000 | 无新消息后的结束建议 |
| `SESSION_MAX_MS` | 3600000 | 会话最长有效期 |
| `READ_WAIT_MS` | 20000 | 每次读取短等待上限，配置最大 25000 |
| `WAKE_TIMEOUT_MS` | 60000 | 等待 Dot 确认会话的期限 |
| `MAX_WAKE_ATTEMPTS` | 3 | 每次会话有限唤醒尝试 |
| `JOB_LEASE_MS` | 30000 | 发件/回调任务领取租约 |
| `GATEWAY_LEASE_MS` | 90000 | 接入控制租约 |
| `MAX_DELIVERY_ATTEMPTS` | 3 | 可重试传输的最大次数 |
| `SUBSCRIPTION_TTL_MS` | 86400000 | 订阅有限期上限 |
| `SECRET_ROTATION_MS` | 60000 | 双签名轮换窗口 |
| `VERIFY_WAIT_MS` | 20000 | 订阅等待回调验证上限 |

微信长轮询 35 秒、发送 15 秒、事件 HTTPS 回调 10 秒是当前接入实现的请求时限，与 Dot 的执行预算不同。参数限制以 `src/core/config.ts` 和 `src/gateway/config.ts` 为准。不要仅为让 Dot 不退出而拉长租约；先记录实际客户端行为。

## 升级与恢复

保留 D1、R2、`DATA_KEY_B64` 和完整接入运行目录，更新源码、应用新增迁移并发布同一私有 Sites 项目。迁移只调整 schema，通过常量默认值把旧记录归属 `personal`；鉴权后 `Participants.initializeLegacy()` 幂等建立原成员并读取旧绑定及网关游标。不改写旧密文、消息 sequence、任务 ID 或 R2 对象，也不清空数据。

升级顺序为：发布 Worker 与新增迁移 → 更新并重启唯一协议 2 接入服务 → 重新扫描 MCP 工具 → 更新 Dot 指令及 all 订阅 → 在管理首页连接第二人。旧单成员调用保留兼容；成员记录总数超过 1 后，历史、主动发送、恢复和附件读取都必须明确 `participant_id`。

自己已发布的站点通过 `GET /gateway/main.js` 提供同次构建的接入程序，要求网关 Bearer 认证；私有 Sites 同时要求 `OAI-Sites-Authorization`。下载到候选文件后，核对本机构建的 SHA-256 并运行 Node.js 语法检查，再原子替换 `/opt/dot-wechat-bridge/main.mjs` 并重启接入服务。升级保留配置、凭据和运行目录。

发布后分别核对 Sites 部署成功、管理接口所有者鉴权、MCP 工具目录及一次真实调用、接入服务与成员状态。服务状态正常不证明真实 Dot 唤醒或微信收件；两人交错对话、主动通知、跨人协作和网页交互按[人工验收](manual-acceptance.md)由用户确认。

失败或结果未知的输出只阻塞对应成员后续发件；在管理页或 ChatGPT 查看 `status_text`、`error_message`。用户检查微信收件后明确选择 `wechat_resolve_reply` 的 retry/skip；unknown 重试需接受可能重复发送。凭据过期在网页为同一微信重新扫码；换成另一个人的微信应新增成员，不清空 D1 或日志代替恢复。
