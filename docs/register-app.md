# registerApp 研究：后续简化接入

**仅检查官方说明和代码接口，没有调用 `registerApp`、生成二维码、扫码、创建应用或取回凭据。** 正式交互必须先确认租户、权限、凭据保存位置与主线程授权。

官方 [Node SDK README](https://github.com/larksuite/node-sdk#app-registration) 描述 `registerApp` 的 device authorization 流程：回调给出短期验证 URL，用户在飞书确认后取得应用凭据。它不是让桥持有飞书用户令牌的授权方式，也不是本桥的 MCP OAuth 发行方。

后续候选配置如下，代码仅作为文档，不在服务或测试中执行：

```js
// REVIEW ONLY — 执行会创建应用并申请持久权限，需要另行授权。
await lark.registerApp({
  createOnly: true,
  source: 'dot-lark-bridge',
  addons: {
    preset: false,
    scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message:send_as_bot'] },
    events: { items: { tenant: ['im.message.receive_v1'] } }
  },
  signal: operatorAbortSignal,
  onQRCodeReady: showShortLivedUrlToOwner,
  onStatusChange: showNonSensitiveStatus
});
```

必须先确认所选权限名在控制台仍受支持。`createOnly` 避免覆盖现有应用；`addons.preset=false` 避免默认模板带入不需要的业务权限，不添加 user scopes / callbacks。默认模板的 additive 权限不能通过 addons 削减，因此不能直接复用 README 中宽权限例子。

SDK 返回 `client_id/client_secret` 以及可选 `user_info.open_id/tenant_brand`。不要照搬把 App Secret 打印到 stdout 的示例。后续实现应直接送入已授权的秘密存储，并只显示非秘密的确认状态；不能通过聊天、日志或 git 回传凭据。

这个返回值没有保证提供本桥必需的 tenant_key 与私聊 chat_id，open_id 也需核实应用作用域。服务仍要求显式绑定完整元组，不自动认领扫码者或第一条入站消息。

README 明确将事件订阅方式、请求 URL、security 和加密参数等排除在 addons 外；扫码创建后仍要在官方控制台或获准的配置 API 中确认长连接模式、机器人能力、可用范围及应用发布。后续不得因扫码成功就认为当前 dot 已接通。

账户域名默认 `accounts.feishu.cn`，国际 Lark 是另一个品牌/域名；本原型只允许飞书。`AbortSignal` 用于取消轮询，需处理拒绝、过期与 abort，并避免留存未获准的应用或权限。全过程仍独立于 OpenAI 插件安装及当前 dot 的事件订阅。
