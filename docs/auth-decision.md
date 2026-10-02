# 最小试用的官方认证选择

截至 2026-10-02，已核实 [OpenAI 插件认证](https://developers.openai.com/plugins/build/auth) 与 [安全 MCP 隧道](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。对目前的 HTTP 桥，**可以复用已有合规 OAuth 发行方，不必为此项目新建独立 OAuth 服务；尚未核实不需要任何发行方、同时可验证一名主人的官方接入路径。** 选用托管平台内置认证也需主线程验证它能给后端提供可信 owner 主体，不能仅凭云端来源就开放工具。

| 官方能力 | 对本桥的意义 | 仍需处理 |
| --- | --- | --- |
| Authorization code + PKCE S256 | 本桥已有 RS256/JWKS 校验，可复用发行方 | discovery、CIMD/DCR 或预设 OAuth client、redirect URI、resource/audience、scope、唯一 owner sub，短期 JWT；发行方实际联调 |
| mTLS 的 ChatGPT client authentication | 验证客户端服务身份 | 仍需最终用户 OAuth；证书不是主人身份 |
| Secure MCP tunnel（开发模式） | 云 VM 内运行出站 tunnel-client，可减少公网 MCP 入口 | 持续云进程和存储、正确 Platform org / ChatGPT workspace、dev-mode 策略、隧道/runtime key；应用 OAuth 流程仍存在 |
| API key / machine-to-machine grant | 官方插件认证未支持用于这种用户接入 | 不能把本地 dev bearer、飞书 app token 或 tunnel key 当作 owner OAuth |
| No auth | 无可验证 owner 身份 | 不满足本人单聊桥的安全要求，代码不开放该模式 |

安全隧道是传输路径；官方文档描述应用仍经历认证生命周期，OAuth metadata 经隧道读取，授权服务器不自动进入隧道。隧道并未给本服务定义可直接信任的每用户 `sub` header。把隧道当成主人认证替代品会削弱当前拒绝策略；这是根据官方传输/认证边界作出的实现判断，不声称所有平台都不能提供内置认证。

此分支没有调用 tunnel API、创建 Platform key、安装插件或启用开发模式。若主线程选隧道，需配置一个与后端可核验 audience 相符的资源 URI，并联调真实 URL/Host、OAuth 和 MCP Events 回调；当前服务仍采用 `PUBLIC_ORIGIN/mcp` 的 HTTPS audience，未声称可直接套用隧道虚拟 URL。隧道仅开发模式，不能用于公开插件分发。

可立即移交的最少服务依赖是：Node 24.15–24.x、单实例常驻进程、一个可靠本地持久磁盘、WSS/HTTPS 出网、获准的应用绑定与 STORAGE_KEY、可核验 owner JWT 的现有发行方，以及当前同一个 dot 的插件/事件订阅。选云端/TLS/OAuth 由主线程处理；本渠道代码不降低认证要求以跳过这些依赖。
