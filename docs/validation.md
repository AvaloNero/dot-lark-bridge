# 本地验证记录

日期：2026-10-02；Windows 独立工作区；Node.js 24.15.0 / npm 11.12.1。测试使用合成身份、合成 token、进程内测试 RSA 与本机 loopback。没有访问真实飞书、OpenAI、OAuth 账户或 dot。

| 检查 | 结果与范围 |
| --- | --- |
| `npm.cmd run check` | 29 个 JavaScript 文件、package/plugin JSON 和 13 份 Markdown 本地链接检查通过 |
| `npm.cmd test` | **77/77 通过，0 失败、0 skipped** |
| `npm.cmd ci --offline --ignore-scripts --no-audit --no-fund` | 52 个依赖从既有缓存安装成功；未执行 lifecycle scripts |
| `npm.cmd run simulate` | 一次 SDK 解析 → 持久队列 → 本地 HTTP MCP 订阅/工具 → 合成原消息 reply；一次事件/一次回答 |
| SDK 1.74.0 integrity | 与官方 `registry.npmjs.org` metadata 完全一致 |
| `npm.cmd audit --omit=dev --registry=https://registry.npmjs.org --json` | 0 项已知漏洞；不是全方位安全保证 |

环境默认 npm mirror 不提供 advisory endpoint，第一次 audit 返回 404；随后直接用官方 registry 完成只读审计，没有执行 audit fix 或修改全局 npm 设置。lockfile 使用官方 registry URL。

## 已覆盖的行为

- 真正的 pinned SDK `EventDispatcher` V2 normalization，以及在不联网条件下调用官方 `WSClient.handleEventData`：持久事务后 success ACK，无 active 订阅时 error ACK。
- App/租户/主人/私聊/字段缺失与覆盖拒绝；群聊、其他人、bot、附件、富文本、引用、mentions 不入队；坏时间、超长文字和无 ID 拒绝。
- 本地 HTTP MCP 2.0 metadata、header mirroring、认证、Origin、body 限额、事件发现/订阅 challenge、TTL、secret 轮换和 schema。
- 持久去重、SQLite 双 handle lease、独立子进程观察已提交队列、服务重启后的事件与回复恢复。
- 频控、容量回滚、期限、固定原 message ID / UUID、没有收件人参数、一份回答及重复工具幂等。
- SSRF、DNS rebinding、公网地址锁定、TLS SNI、禁止 redirect、超时与响应限额、OAuth RS256/JWKS/claims。
- unsubscribe 在 token 刷新、DNS 和 callback verification 中的竞争；同 callback 再订阅的 generation 隔离；已在网络上的确定 ACK 与优雅关闭。
- 5xx、损坏/丢失/错 chat ACK 和崩溃回复的 uncertain 无重发；401/429 明确拒绝后的有界重试。
- 原始 SDK payload / WSS URL / 错误细节不记录；正文与 callback secret 不以明文进入测试库。
- 注册向导离线 plan、显式执行门槛、minimal tenant grants、新私有文件与禁止覆盖、凭据不输出、取消/拒绝/过期/品牌切换、未配对文件及身份冲突拒绝。
- 官方 dispatcher 配对验证已知主人与租户、p2p 精确短期口令、原 header、防抢配对/重放/过期；成功或取消后关闭假 WSS transport，不启动 MCP/发送消息。
- 脱敏本地状态与获准 app-token/bot-info probe 的注入假响应；正常生产仍要求 OAuth，关闭期间的 endpoint discovery 不能恢复连接。

模拟输出明确为：

```json
{
  "mode": "OFFLINE_SIMULATION",
  "current_dot_connected": false,
  "real_lark_connected": false,
  "real_websocket_connected": false,
  "official_sdk_dispatcher_used": true,
  "local_http_mcp_used": true,
  "events_delivered": 1,
  "lark_replies": 1,
  "same_conversation": true,
  "reply_text_source": "fixed_test_fixture"
}
```

## 仍待真实验收

SDK WSS 握手/断线重投、真实应用权限/启用和绑定、OAuth 流程/刷新/撤销、目标同一个 dot 的插件事件订阅及模型回应、飞书 UI 原私聊位置、云端实例与持久卷、电脑离线场景，均未验证。Docker 未构建，插件模板仅 JSON 解析，没有实际安装或发布。

不能把模拟测试或 2xx 回调称作已接通飞书、QQ 或当前 dot。真实依赖与验收项在 [activation.md](activation.md)，故障限制在 [architecture.md](architecture.md) 与 [security.md](security.md)。注册与配对仅在测试中注入假 SDK，没有调用真实 registerApp、取得真实凭据或连接飞书；源码包及启动模板不是实际云端验收。


## 2026-10-02 云电脑真实授权与诊断边界

- 经逐项批准，对现有应用调用官方扫码流程；官方 begin 200，用户确认后 poll 200，回传 App ID 与批准目标匹配。秘密只留进程内存，未输出或持久保存。
- 同次批准的 15 秒 WSS 诊断超时；当时没有细分阶段证据，不能判断是 HTTPS 地址发现慢还是 WSS 握手慢，也不能据此断言权限错误。
- 初次观察会话被工具审核拒绝；补充授权证据后原样重试一次，进程已不可访问。后续获准重试加入安全进度日志，才取得上述成功回传证据。
- 用户转向正式持续连接后，新的短诊断会话在授权前取消并退出；上一份内存凭据按十分钟期限自动丢弃并退出，未建立正式服务。
- 现新增持续服务与私有存储入口，仅离线实现/测试。长期凭据保存、tenant/owner/chat 绑定、OAuth、真实 MCP Events 订阅、持续运行环境及同一个 dot 往返仍未验证。gateway ready、进程心跳和真实模型回答互不等价。


## 双模式合成验证与正式保存尝试

- tunnel/sites 显式选择、共享应用锁、数据库模式绑定、Sites owner/subscription 租约、一次性claim加密持久化、过期与崩溃后 uncertain、ACK-only 恢复及关闭时等待入站均有离线覆盖。
- 通过 `scripts/check-sites-contract.js` 对实际 Sites 本地路由/内存 D1 实现验证一条 Lark 事件回调、一条原消息回复和跨owner拒绝。外部网络、callback和飞书发送全部替换为合成实现，不能当作真实 dot 接通。
- 获准正式扫码保存的会话已取得官方链接，但用户确认回传前的一个poll请求没有响应并结束为registration_failed。已验证批准的私有目标文件仍不存在；没有生成假tenant绑定、没有保存或输出真实秘密、没有启动服务。该结果与合成测试成功分别报告。
