# 两种明确的桥接模式（当前仅私有合成测试）

`BRIDGE_MODE=tunnel|sites` 是正式入口的必选项；空值、auto、both 均不能启动。不存在失败后切换，或同一应用两路并行消费。`scripts/run-service.js --confirm-persistent-service` 统一选择单一运行时；旧 `src/main.js` 不允许启动真实长连接。

## tunnel

沿用现有 Node `/mcp`、OAuth owner、DNS/IP 固定回调和持久队列。OpenAI MCP Tunnel 只是获准时可用的入口传输；代码选择 tunnel 不等于已经创建实际隧道、授予 Platform key、安装插件或接入当前 dot。仍需完整官方认证和真实订阅。

## sites

Node 不开放 HTTP/MCP，只接获准飞书长连接并向指定 Sites origin 出站。Sites 持有自己的用户认证、私有 MCP Events 订阅与回复队列；平台 service 凭据不是用户身份。每 binding 的独立 connector 凭据必须由 Sites 服务端映射正确 owner/channel，绝不能由请求 body 中 owner 字段决定。分享产品以后，每个用户须有隔离的 binding/凭据/订阅/存储；当前没有开放公共注册。

固定协议（所有请求双认证 `OAI-Sites-Authorization` 和 binding `Authorization`；不记录值）：

- `POST /bridge/lease`：binding_id + instance_id，必须返回 lark、sites、当前 subscription_id、lease_token 与最多90秒过期时间。没有有效订阅不能接收；约30秒续租，失败停飞书消费，不自动换模式。
- `POST /bridge/inbox`：带当前租约和 subscription_id，以及已通过原 owner/tenant/app/p2p/text 验证的消息。稳定 message_id/event_id，冲突或旧订阅拒绝。
- `POST /bridge/outbox/claim`：一次性领取 message_id/text/reply_deadline/subscription_id/claim_token/claim_expires_at。先用本地 STORAGE_KEY 加密耐久保存 claim，再以原 message_id 回复；不接受自选收件人。
- `POST /bridge/outbox/ack`：sent/uncertain/dead 固定状态。未知发送结果永不重发；丢 ACK 只重试同一 ACK。claim 到期停发；重启时 processing 变 uncertain。

Sites origin 使用原 HTTPS 公网 DNS/IP 固定发送器，不扩大 provider proxy 例外。不把任意 URLs、回调目标或用户数据塞到认证路径。此路的真实托管、平台/connector 凭据、出网和原子租约服务尚未真实联调。

## 同机互斥和迁移边界

两模式必须使用同一个 `BRIDGE_LOCK_DIRECTORY` 私有目录。锁键是 `sha256('lark:' + appId)`，不含模式或数据库路径；wx 原子获取，0700目录/0600锁文件，拒绝路径symlink。退出只删除自己的nonce锁；崩溃或锁改变时默认拒绝，需操作者明确恢复。该锁只协调同一云电脑、同一个共享锁目录，不声称跨主机的全局 fencing。

数据库存储 bridge_mode 并拒绝静默切换。迁移须先停旧服务、撤销/清理旧订阅并确认未知发送状态，再由操作者明确规划新模式/新库。不同目录或复制到另一台主机不能被当成安全绕过互斥的方法；未来跨机器分享部署需额外的共同权威租约设计。

## 当前验证状态

所有模式/队列测试仅合成凭据、临时数据库与注入传输。未创建隧道、Sites授权凭据或公开发布；未把私聊投到真实 Sites。gateway连接、Sites租约和 current-dot 端到端验收分开，任何 ready 均不自动证明模型已经回复。

## Personal tunnel service readiness

The explicit `AUTH_MODE=tunnel-service` mode is a personal deployment readiness
listener, separate from OAuth. Use `BRIDGE_MODE=tunnel`, `HOST=127.0.0.1`,
`LARK_TRANSPORT=disabled`, an absolute `TUNNEL_SERVICE_KEY_FILE`, and a local
`TUNNEL_SERVICE_OWNER_ID` such as `tunnel-owner:dot-bridge`. The key file must
contain one canonical base64url encoding of 32 random bytes (optional final
newline), be owned by the running user with mode 0600, and have an owned 0700
parent directory. Linux descriptor-relative traversal pins each directory; unsupported
platforms fail closed. Symlinks and hardlinks are rejected. Keys are never printed.
Provisioning a real key requires explicit approval; tests use synthetic keys.
Mixed OAuth/dev, provider credential and callback settings are refused before any
provider credential file is read.

Run `node scripts/run-tunnel-readiness.js` only after that setup. This entry uses
a fresh in-memory store and an ephemeral encryption key on every start; supplied
`DATABASE_PATH` and `STORAGE_KEY` are refused and no existing queue is opened. The tunnel
client supplies exactly one `X-Dot-Bridge-Service-Key` header. Bearer credentials,
forwarded authentication, and caller identity headers are rejected. Every
holder of tunnel Use permission is treated as this one local deployment owner;
this is not a verified external user identity and is unsuitable for a shared
multi-user instance. Share code and separate deployment instructions instead.

This entry exposes only discovery, empty tool/event catalogs, and ping. Provider
owner/tenant/chat binding, subscriptions, message access, queue draining, and
message forwarding are disabled. `TUNNEL_SERVICE_READINESS_ONLY=false` is refused.
The existing OAuth, dev and Sites modes retain their previous behavior. A successful
tunnel readiness response does not establish a live Feishu or current-dot connection.

## Explicit personal live operation (not activated by this implementation)

`TUNNEL_SERVICE_OPERATION` defaults to `readiness`. The readiness entry always
rejects `live`, uses an empty memory store, and cannot subscribe or send. Live
startup is a separate command:

```sh
node scripts/run-tunnel-live.js --confirm-live-owner-bridge
```

Without that exact flag it prints a plan and reads no files. Live requires
`AUTH_MODE=tunnel-service`, `BRIDGE_MODE=tunnel`, `TUNNEL_SERVICE_OPERATION=live`,
`TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge`, loopback `HOST`, and
`LARK_TRANSPORT=long-connection`. Supply three distinct absolute private file
references: `TUNNEL_SERVICE_KEY_FILE`, `LARK_CREDENTIALS_FILE` (version 1, paired),
and `STORAGE_KEY_FILE` (canonical base64url 32-byte key). Pin the authorized app
using `LARK_EXPECTED_APP_ID`. Set an explicit `DATABASE_PATH` in an owned 0700
directory and an owned 0700 `BRIDGE_LOCK_DIRECTORY`. No inline app secret,
storage key, claimed provider owner, OAuth/dev or Sites settings are accepted.
The operator provisions real secrets only with specific approval; this command
never generates them. The fixed local owner is not an external identity claim.

An empty callback allowlist is a supported pending state. Verified owner binding
permits the fixed event catalog and the local `check_lark_setup` inspection tool.
Its optional `callback_url` produces only a hostname, a policy enum and readiness
booleans; it never resolves DNS, contacts the URL, logs the input, or changes
permissions. A subscription to an unapproved hostname returns only the safe
`callback_policy_required` classification and hostname. Actual callback policy
must come from the current dot's subscription, never a guessed hostname.

An approved subscription still performs the existing signed verification,
HTTPS/public-DNS/IP-pinning checks and one-active-subscription fencing. The
Feishu gateway starts only while an unexpired subscription for the fixed owner
exists, and closes when it expires or is revoked. Discovery/tool access alone
never enables messages. Existing OAuth and Sites remain separate supported modes.

Payload encryption covers message/reply text and callback URL/signing secrets,
not the entire database: owner/app/tenant/chat/message metadata and deduplication
tombstones remain readable. The seven-day text retention policy runs while the
worker operates; it is not secure erasure of WAL pages, snapshots or backups.
Starting a real bridge needs approval for continued private-message receipt,
transfer to the current dot, same-conversation replies, and persistent state.

The live SQLite directory and journal/WAL/SHM paths are checked for ownership,
private modes, symlinks and hardlinks before use. SQLite still opens its database
by pathname: this assumes the runtime's OS user and its private directories are
trusted. It is not protection against malicious code running as the same UID.
Credential reads/writes separately use pinned directory descriptors. A live
library caller must present the actual private file references: the store rereads
and compares paired identity, expected app and independent storage key before
opening any database; a synthetic `pairedCredentialsLoaded` flag is insufficient.

## Callback transport dependency and pending proxy support

Clone `dot-qq-bridge` and `dot-lark-bridge` as sibling directories. The callback
integration imports `dot-qq-bridge/packages/dot-bridge-transport/index.js`
(`@dot-bridge/callback-transport`), which is versioned inside the QQ repository.
No third untracked workspace is required.
Each person deploying the bridge supplies their own copy and private credentials.
Only signed callback verification and event delivery use `purpose: 'callback'`.
Provider requests, OAuth key retrieval and the Sites queue retain their separate
request paths.

`callback_transport` is a closed local preflight result, with `ready`, `mode`,
`reason`, `proxy_configured`, `destination_binding`, and `network_checked:false`.
A ready preflight means a configured transport can be attempted, not that a
platform callback has been reached or that a proxy contract was independently
verified. The managed-proxy case requires a supported adapter implementation;
without one it fails before DNS or opening a request. It never silently falls
back to direct traffic. No environment flag can assert adapter verification.
An unannotated injected sender is `transport_unverified`, not proven readiness.

Setup inspection, readiness output and lifecycle heartbeat expose only this
fixed status object. Callback failures preserve a finite transport reason with
RPC code -32015; causes, URLs, headers, signing keys and message text are omitted.
In explicit tunnel live mode, a blocked callback transport also keeps the gateway
closed even when an old durable subscription exists. Proxy refusal remains a
missing capability to resolve, not successful implementation of managed proxy
support. Tests using synthetic adapters verify application routing only.
