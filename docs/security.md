# 安全边界

本原型只开放一个主人、一个租户、一个已知私聊的文字桥。认证与路由是服务端约束，不能被文字、模型参数或 `clientInfo` 改写。

| 边界 | 服务端约束 |
| --- | --- |
| 飞书来源 | 官方应用认证长连接、TLS、官方 WSS 域名和公网 DNS；没有 HTTP 消息注入入口 |
| 入站身份 | V2 header AppID/tenant + sender tenant/open_id/type + 固定 p2p/chat_id；缺字段拒绝 |
| 内容 | 2000 字符以内纯文本 JSON，无附件、群聊、富文本、引用或 mentions |
| MCP | 默认 deny；生产 OAuth RS256 / JWKS / iss / aud / sub / scope / exp / nbf 校验 |
| 回调 | 一个 active 订阅；签名 challenge、明确域名白名单、DNS 公网锁定、禁止跳转 |
| 回复 | 已验证入站 ID + 本订阅投递尝试 + generation；无目标地址参数；固定原消息 reply |
| 故障 | 有界队列与频控、持久去重；未知发送结果不会重发 |
| 秘密 | 环境模板空值；正文、回复和回调材料加密；应用 token 仅内存；SDK 原始日志丢弃 |

不允许 Cookie、浏览器登录抓取、用户 access token 伪装或非官方消息协议。只使用自建应用的 App Secret 和 `tenant_access_token`。不提供发任意聊天、主动消息、文件访问、模型 API、读取/导出 dot 记忆的工具。

## 注入与高后果操作

MCP payload 仅有 `message_id/conversation/text/reply_deadline` 数据。事件文字无论是否来自主人，都不授予新的工具权限。服务说明要求付款、删除、外部写入、凭据请求和记忆导出回 ChatGPT 确认。

桥不能审查 dot 所拥有的其他插件或在其运行环境中强制确认。真实接入前必须在 ChatGPT 配置自动任务与其他工具权限，并测试恶意文字不会触发高后果动作。模型仍可能把敏感内容写进普通回复；操作者应约束该订阅的回答范围。不要把描述或 prompt 当作沙箱保证。

## 撤销与数据

在 ChatGPT 停止订阅会使 `events/unsubscribe` 将工作取消；epoch/generation 保护并发撤销与再订阅。紧急时停止云服务或保持原身份配置、将 `AUTH_MODE=deny` / `LARK_TRANSPORT=disabled` 后重启，再撤销平台应用授权。

JWT 是离线验证，没有发行方 introspection。已有签名 token 在有效期内和 JWKS 缓存窗口内仍可能有效；订阅最长不超过创建/刷新时 token 的 exp。要求快速断开的场景需发行方短期 token，并采用上述停机/deny 方式。单纯在发行方删账户不等于桥已实时观察到撤销。

本次没有创建秘密或持久权限。测试 RSA 和 fixture key 全为进程内合成数据。`.env`、数据卷、日志和 node_modules 均不提交；存储 key 要由之后获授权的操作者安全提供。SQLite 明文路由身份、墓碑、备份、WAL 和主机访问须额外保护；密钥与备份不能同权限公开保存。

服务目前不提供公共管理面板、消息撤回、批量历史拉取或失败消息重发按钮。未知回复必须先在原飞书私聊人工核对，不能改库强制 retry。TLS 终止代理必须保留受校验 Host，防止公共网络绕过代理访问后端。
