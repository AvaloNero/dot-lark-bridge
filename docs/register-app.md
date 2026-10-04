# 官方扫码注册与本人单聊配对

已提供可审查、带显式执行门槛的操作向导。**2026-10-02 已验证现有应用官方扫码授权回传；随后一次获准的 15 秒 WSS 诊断超时，未证明长连接接通。未配对、未保存真实凭据、未启动正式服务。** 自动化测试使用合成数据、注入实现或本地模拟 TLS/代理；实测与离线测试分开记录。

先运行无网络、无写入的预览：

```powershell
npm.cmd run setup -- plan
```

默认命令也是 plan。源码在 [setup.js](../src/setup.js)；它调用官方 [Node SDK registerApp](https://github.com/larksuite/node-sdk#app-registration)，而不是模拟用户登录。开始任何真实命令前，应由主线程取得 [最少授权](authorization.md)。`--confirm-*` 仅表示操作者已获得该授权，不是替用户授权。

## 已有应用：优先复用，不重建

锁定的官方 SDK **1.74.0 支持已有应用重新扫码授权**：传 `appId`，并且不能传 `createOnly: true`。官方确认页展示 addons 带来的权限差异；用户确认后更新该应用配置并回传凭据。这不是不修改配置的“登录”，也不证明已有配置会完全不变。官方说明见 [SDK 参数](https://github.com/larksuite/node-sdk#app-registration)。

内存会话 `createRegistrationSession({ approved: true, existingAppId })` 现支持此路径。必须先核实非秘密 App ID，并取得针对该应用、两项 tenant scopes、一项事件以及凭据回传到云电脑内存的授权。页面需包含完全相同的 `clientID`，且不得设置 `createOnly=true`；回传 App ID 不同则丢弃凭据。未提供 existingAppId 的旧会话仍为新建模式，不能作为复用已有应用的替代。

内存会话不自动保存或启动桥；私有存储仍需另行批准。无需用户重新创建应用或在终端键入 Secret。操作者不得从旧聊天或本地电脑自行迁移凭据。确认后仍须核对 tenant、owner 身份、应用权限、启用状态与长连接设置；现有代码不声称已完成这些真实验证。

注意：SDK 默认注册使用自身 Axios 网络实现。专用 `scripts/scan-existing.js` 子进程替换其注册 POST 为固定官方端点的 TLS CONNECT 实现：禁止重定向、国际品牌切换、额外端点和参数、代理缺失/NO_PROXY 直连回退；响应、等待和缓冲均有上限。只在独立注册进程替换，不能在常驻桥中修改 SDK 默认客户端。此路径已通过锁定 SDK 配合模拟 CONNECT/TLS 的离线测试；真实扫码 begin 与授权回传均已返回 HTTP 200，回传 App ID 匹配；这不独立证明全部权限、配对或持续 WSS 可用。启动等待已加独立截止时间，SDK 忽略 abort 时也会停止等待，晚到的验证链接不会展示；这不会自动取消平台上用户已经确认的修改。真实流程不得在审核/授权之前执行。

## 新应用专用：一次扫码创建一个应用

先选择获准租户并取得可核实的 tenant_key，选择已存在的私有目录及两个不同、尚不存在的文件名。Linux 目录须 0700、文件 0600；Windows 向导在写入秘密前撤销文件 ACL 继承，仅授予运行账户与 SYSTEM。不会覆盖文件、跟随路径中的 symlink，也不会自动创建秘密目录。云端 secret store 可用获准的秘密挂载，不能使用源码目录或公共下载目录。

```powershell
# ONLY after main-thread approval. Replace placeholders locally, never paste secrets in chat.
npm.cmd run setup -- register --credentials <private-registered.json> --tenant-key <approved-tenant-key> --confirm-create-app
```

向导在操作者终端显示短期官方 HTTPS 验证链接及到期时间。主人在飞书扫码/打开该页面并确认；链接不持久写入日志。默认最多等 10 分钟，Ctrl+C/SIGTERM 可取消。拒绝、过期、非飞书品牌或切换至国际 Lark 均不保存凭据。

固定请求如下，不接受外部传入 scopes、domain、appId 或 callbacks：

```js
{
  domain: 'accounts.feishu.cn',
  createOnly: true,
  source: 'dot-lark-bridge',
  addons: {
    preset: false,
    scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] },
    events: { items: { tenant: ['im.message.receive_v1'] } }
  }
}
```

`preset=false` 采用最小机器人基底，避免 SDK 默认模板的额外业务权限。没有 user scopes、Cookie、用户 token、通讯录、日历、群聊权限；该新建命令不提供已有应用入口。确认页面允许用户修改，操作者仍须核对实际授予的权限，向导不声称已自动核实全部权限。

SDK 返回的 AppID/Secret 直接存入私有 JSON，只输出保存成功及是否取得主人候选 open_id。SDK 返回的可选扫描用户 open_id 必须属于获准主人；若缺失，保持未配对，先通过批准的官方资料核实应用内 open_id，再在本地配对命令提供。tenant_key 不从第一条事件猜测。

官方 SDK 的 addons 不配置事件订阅方式、安全参数等。扫码后仍需在官方控制台确认：应用机器人启用，仅主人可用，`im.message.receive_v1` 使用长连接，按租户审批规则发布/启用。拒绝或取消不会自动删除已经由主人确认创建的应用；保存失败需在官方控制台核查已有应用，不能盲目重复创建。

## 配对：主人发送一次短期口令

```powershell
# ONLY after main-thread approval, console enablement, and verified owner identity.
npm.cmd run setup -- pair --credentials <private-registered.json> --binding <private-paired.json> --confirm-bind
# Only if the SDK did not return the verified owner's open_id:
# append --owner-open-id <verified-app-scoped-open-id>
```

配对进程没有 MCP HTTP 服务、队列转发或回复工具。它用官方应用身份 WSS，在终端给出随机 192 位、5 分钟有效的 `pair ...` 文字；主人在该机器人的单聊发送完整口令。只有原始事件 header 的 app/tenant、sender 的已知主人/tenant/user 类型、p2p 纯文字、时间及精确口令全部匹配才保存 chat_id。其他人、群聊、覆盖 header、附件、引用、mentions、旧消息、过期或重放均不能改绑定。

首次发送者永远不能成为主人。若显式 owner 与扫描用户不一致，向导拒绝。配对成功立即关闭连接，将完整 app/tenant/owner/chat 元组写入新的私有文件；不启动桥，不建立 dot 订阅，不发送消息。

服务从获准的秘密挂载加载绑定：

```dotenv
LARK_CREDENTIALS_FILE=/run/secrets/lark-paired.json
```

若文件未完成配对或与环境身份冲突，启动失败。单独加载文件不会开启 OAuth 或长连接，仍需完整生产配置、独立 STORAGE_KEY 与当前 dot 订阅。转移到云端秘密存储和删除初始凭据副本应在获准流程中处理，不经聊天/邮件传递秘密。

## 脱敏检查

```powershell
npm.cmd run setup -- status --credentials <private-paired.json>
npm.cmd run doctor
npm.cmd run status
# ONLY after approval for an app-token and read-only bot-info probe:
npm.cmd run doctor -- --live --confirm-remote-read
```

setup status 只读文件；doctor 默认只读配置和已存在的数据库，不创建库、不联网、不输出 ID、秘密、正文或回调 URL。status 输出队列统计。获准 live probe 仅请求应用 token 和 GET bot info，输出布尔结果，不校验完整权限、主人身份或模型回应；不能当作 WSS 或当前 dot 已接通。

## 单独获准的有界 WSS 诊断

`node scripts/doctor.js --live-wss --confirm-wss-diagnostic` 只在另行批准一次短期连接后运行。默认 15 秒，SDK 自动重连关闭，只把 ready 回调当作握手成功；`start()` 提前返回不算成功。结束、失败、超时、取消都会关闭 SDK 和 WSS agent。已在途的 HTTPS discovery 请求仍受其自身网络截止时间约束；关闭后拒绝晚到 endpoint，不再发起 WSS。

诊断不建立 MCP 服务或订阅、不存储或转发私聊；收到事件时抛错使 SDK 返回错误 ACK，而非成功消费。不保证平台重投，因此可能影响同时使用同一应用的其他消费者，应选择没有现有消费者活动的测试窗口。成功仅说明短期 WSS 握手，不证明本人身份、事件权限、消息收发、MCP 回调、OAuth 或当前 dot 连通。2026-10-02 已执行一次获准的 15 秒诊断并超时；后续 60 秒诊断会话因用户改为正式接入方向而在授权前取消，未执行。


独立进程命令（只能在明确获得对指定现有 App ID 的扫码更新、内存凭据回传及短期 WSS 检查授权后运行）：

```sh
node scripts/scan-existing.js <approved-app-id> --confirm-existing-app-scan --confirm-memory-only-wss-probe
```

该命令不保存任何凭据；扫码确认后运行最多 15 秒 WSS 诊断，随后仅在进程内存保留凭据 10 分钟，到期或 SIGINT/SIGTERM 丢弃。只输出官方验证 URL、状态、截止时间和脱敏诊断结果，不输出 device code、App Secret、owner ID 或原始 SDK 错误。无凭据导出接口；此命令不是长期服务或已连接 dot 的凭据配置流程。


正式使用请转到 [持续服务与私有存储](deployment.md)，不要反复运行临时诊断扫码脚本。临时诊断仍保留给有明确单次测试需求的操作者；其可选 60 秒总预算仅在另获批准时使用，HTTP 发现 30 秒、WSS 握手 10 秒，阶段日志不含任何载荷。未来会话的 stdin 只接受 status、discard，以及带 --confirm-wss-diagnostic 的 probe15/probe60；每次诊断都须先取得对应争抢窗口的批准，不自动重试、不续期内存保留。

用户已明确批准保存应用凭据而 tenant 尚未核实时，可在正式 enrollment 命令的 tenant 参数位置使用 `--tenant-pending`：保存为 unbound 状态，不填假 tenant。此文件不能用于配对或正式服务，必须后续验证身份并生成完整绑定；不会启动短诊断或自动丢弃已保存凭据。

### Controlled import for an existing unbound enrollment

Do not rescan if approved app credentials are already saved. An `unbound` file
needs a verified tenant and owner before pairing. The plan-only command is
`node scripts/import-verified-identity.js`; it reads no files without the exact
commit flag. After an operator inspects the official Feishu source and obtains
the owner's exact app/tenant/open_id confirmation, use:

```sh
node scripts/import-verified-identity.js PRIVATE_UNBOUND PRIVATE_EVIDENCE NEW_PRIVATE_REGISTERED --confirm-verified-owner-binding
```

The private evidence JSON must contain exactly `version:1`,
`source:'operator-reviewed-official-source'`, a clean HTTPS `sourceUrl` at
`open.feishu.cn` or `accounts.feishu.cn` without query/fragment, `verifiedAt`
(within 24 hours), `appId`, `tenantKey`, `ownerOpenId`, and matching
`confirmedAppId`, `confirmedTenantKey`, `confirmedOwnerOpenId`. These are an
operator attestation and exact user confirmation, not automatic verification or
a substitute for reviewing the source. A scanning-user mismatch is rejected.
Never derive the owner or tenant from the first incoming event. The import makes
a new registered file without overwriting the enrollment; it does not start a
connection or send a message.

Pairing now waits for the actual SDK connected callback (connection wait bounded
separately) before displaying the random challenge and beginning its validity
window. Only the verified owner can bind the private chat. The resulting paired
file is required for live operation. Linux private file I/O is descriptor-pinned
with owned 0700 parent / owned 0600 singly-linked regular-file checks. File
permissions protect credential storage; they are not encryption.
