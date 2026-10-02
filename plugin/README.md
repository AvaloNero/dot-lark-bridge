# 手动接入模板（未安装）

`plugin.json` / `mcp.json` 按 [官方 portable plugin 格式](https://developers.openai.com/plugins/build/plugins) 编写，端点 `https://bridge.example.invalid/mcp` 为不可用占位符。JSON 检查不代表通过客户端扫描或插件安装。

后续获得主线程授权、完成云端 HTTPS 与 OAuth 后，替换为实际获批准端点，按 [连接与测试文档](https://developers.openai.com/plugins/deploy/connect-chatgpt) 在目标现有 dot 配置插件。需要扫描 tools/events、完成 OAuth、在该 dot 内明确订阅，随后执行 [真实接入验收](../docs/activation.md)。

没有本地 marketplace、自动安装脚本、技能自动授权或秘密文件。本次没有修改用户全局 `.agents` / `.codex`、注册客户端或产生持久权限。长期云端运行需要实际托管资源；本地模板目录不维持服务在线。
