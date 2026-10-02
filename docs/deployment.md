# 常驻云端部署与操作（模板，未部署）

最终运行位置应是获批准的单实例云 VM 或持续运行的容器服务。需要持续进程/CPU、稳定 HTTPS MCP 入口、出站 WSS 与 HTTPS、持久卷、TLS 和秘密管理。停止用户电脑不能影响云实例。静态网站、请求结束就冻结的函数和会休眠的实例不满足要求；本次未选择供应商或产生费用。

## 发布前准备

- 审批供应商、地区、数据存储/备份范围、预算、OAuth 发行方和身份绑定；完成 [activation.md](activation.md)。
- Docker 模板使用 Node 24；正式发布前锁定获审核镜像 digest。`package-lock.json` 固定 SDK 与传递依赖；构建使用 `npm ci --omit=dev --ignore-scripts`。
- 以非 root 用户运行，`DATABASE_PATH=/data/bridge.sqlite` 挂独占可写持久卷，严格限制卷 ACL；秘密从独立 secret store 注入，不进镜像、构建参数或仓库。
- 在反向代理提供 `PUBLIC_ORIGIN` 对应 HTTPS，保留原 Host。后端仅允许代理访问，不能公开裸 3000 端口；不要记录 Authorization 或请求正文。
- 允许出网至飞书、已审批的 callback 域名与发行方 JWKS；确认 DNS 返回公网地址，TLS 正常。WSS 在每次连接时重新检查 DNS，SDK 处理 TLS 和重连。
- 一个实例、一份数据库。不能将两个独立卷的 SDK 客户端做负载均衡；SQLite 网络共享盘和多机高可用不属于本原型。

容器模板提供 `/healthz` 存活探测，`/readyz` 还要求有效订阅和 SDK connected；未有订阅时 503 属于预期接入状态。它们都不验证模型已回答、飞书 UI 已收到或用户已读。SDK permanent failure 需监控、修正凭据/配置后由操作者重启。

## 启停与恢复

用平台 supervisor 自动恢复进程，留出至少 45 秒优雅停止时间。SIGTERM 停止 SDK 重连及接收、暂停 worker，等待当前 timer worker 后关闭数据库。不要在正在发送时直接销毁卷。

进程恢复后，event lease 到期可按原 event ID 重投；reply processing lease 到期变 uncertain。pending 回复继续前复查原身份、subscription generation、期限和服务端路由。不得把 uncertain 改成 pending，或用新 UUID 重发原消息。

脱敏状态检查：

```powershell
npm.cmd run status
```

命令只读现有数据库并输出数量/状态，不需要解密正文。不应将数据库下载到公共位置或在错误排查中转发完整环境。

先在 ChatGPT 停止订阅并核对 cancelled。紧急断开可先停服务；或者保持原身份元组，以 `AUTH_MODE=deny` / `LARK_TRANSPORT=disabled` 重启，再处理飞书应用与发行方授权。已经上网的发送无法撤回，随后确认 ACK 会记录 sent。

## 备份与保留

SQLite WAL 不能只复制正在写入的单个主文件。使用 SQLite 一致性备份，或优雅停机后备份主库及必要 WAL；备份存储密钥应单独保护。恢复必须带原身份配置与原 STORAGE_KEY；数据库拒绝换身份和换 key。

正文/回答默认 7 天逻辑清除，永久去重墓碑与统计仍会增长，需监控卷容量。备份、WAL 和旧页可能继续含加密历史；逻辑删除不是物理擦除。长时间中断、未订阅及平台已过重投期限的消息可能丢失，服务不拉聊天历史补齐。

本次未执行 Docker build、云部署、反向代理配置、秘密创建、付费选择、插件安装或用户电脑离线的真实验收。
