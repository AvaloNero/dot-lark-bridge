# 云端源码交接与启动

交接目标是由主线程在获准的云机器/持续容器中运行，用户电脑只用于初始批准或扫码。此仓库没有选择云供应商、创建资源、构建发布镜像或将本机运行当作云托管。

## 源码包

```powershell
# Local, after committing reviewed sources; no network, push or deployment.
npm.cmd run handoff
```

命令从干净 HEAD 导出 `handoff/dot-lark-bridge-<commit12>.zip` 及同名 JSON。清单含完整 commit、SHA-256、字节数与版本需求，源包不含 `.git`、`.env`、`.secrets`、数据库、node_modules 或 npm cache。只导出代码/测试/文档/部署模板及空环境模板；不覆盖旧包。交接应核对 SHA-256，解压到指定云源码目录，再从 lockfile 安装依赖。依赖下载须有获准网络。

```sh
# In the extracted source directory. These commands do not create an app.
node --version                 # require >=24.15 and <25, with built-in node:sqlite
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run setup -- plan
npm run doctor                 # default local read only; no database creation
```

`handoff` 命令在源码 ZIP 内不包含 `.git`，不能再次打包；以后导出由有原始本地提交的工作树完成。ZIP 的验证测试仍全部使用合成数据，不需要真实账户。

## 常驻服务配置

完成 [授权](authorization.md)、[扫码配对](register-app.md) 及 [真实接入](activation.md) 后，主线程把空 `.env.example` 的值放入批准的秘密存储；应用配对 JSON 单独做私有只读挂载。核心字段如下，均为占位符，不含可用秘密：

```dotenv
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/dot-lark-bridge/bridge.sqlite
STORAGE_KEY=<approved-base64-32-byte-key>
LARK_CREDENTIALS_FILE=/run/secrets/lark-paired.json
LARK_TRANSPORT=long-connection
AUTH_MODE=oauth
PUBLIC_ORIGIN=https://<approved-mcp-host>
OAUTH_ISSUER=https://<existing-approved-issuer>
OAUTH_JWKS_URL=https://<existing-approved-issuer>/<jwks-path>
OAUTH_AUDIENCE=https://<approved-mcp-host>/mcp
OAUTH_REQUIRED_SCOPE=lark:bridge
MCP_OWNER_SUBJECT=<verified-owner-subject>
MCP_CALLBACK_ALLOWED_HOSTS=<exact-approved-callback-host>
```

只允许单个 Node 进程独占一个可靠本地持久卷。SQLite 自带 WAL 与 FULL 同步，队列 worker 每 500ms 运行；worker 在同一个常驻服务中，不另开 cron 或第二个 worker。磁盘挂载必须可写且保留重启内容；不使用网络共享 SQLite、多副本独立盘或请求结束冻结的函数。为数据目录设置 0700，secret 文件 0600 且运行用户可读。Docker 运行用户是 node/UID 1000；只读 secret 挂载也须具备该用户的读取权，不能把文件改成所有人可读。

Node 启动方式（真实配置与启动前先批准）：

```sh
node --env-file=/run/secrets/dot-lark.env src/main.js
# One supervisor-managed instance. /mcp must be behind the approved HTTPS ingress.
node --env-file=/run/secrets/dot-lark.env scripts/doctor.js
node --env-file=/run/secrets/dot-lark.env scripts/status.js
```

提供 [systemd 审核模板](../deploy/dot-lark-bridge.service.example)，需主线程确认用户/源码位置/secret mount 和服务启用后再安装。它设置单服务、0700 状态目录、45 秒优雅停止、失败重启与文件系统限制；不会自动创建账户或开启服务。Docker 模板也可使用，构建/registry/镜像 digest、卷、代理与费用由主线程批准。

## 入口、监控和恢复

后端 3000 仅代理可达；代理提供批准的域名 HTTPS 并保留 Host、Authorization 与 MCP header，不记录 Authorization/正文。需要出站 Feishu HTTPS/WSS、发行方 JWKS 和已批准的事件 callback host。SDK 负责长连接重连，安全代理每次连接校验公网 DNS/TLS。

`/healthz` 仅存活；`/readyz` 要求 SDK connected 与有效订阅，因此新实例尚未绑定目标 dot 时 503 正常。`doctor` / `status` 输出布尔值、数量、队列状态；不会输出正文、密钥或身份元组。app-token/bot-info 远程探测只在获准 `--live --confirm-remote-read` 下执行。

SIGTERM 后等待至少 45 秒，不在 worker 正在发送时删卷。重启事件可按原 ID 有界重投，处理中回复会变 uncertain 并禁止自动重发。备份用 SQLite 一致性机制或优雅停止，不能只复制活跃主文件；恢复保持原 STORAGE_KEY、身份和订阅 generation。更详细流程见 [deployment.md](deployment.md)。

验收需要云端实例持续运行时，主人电脑离线后仍由同一目标 dot 完成一条真实原私聊回复，并检查重启、撤销和 uncertain 状态。源包、fixture 测试和 200 health 都不能替代该验收。


## 双仓库源码交付

飞书源码 ZIP 不是独立运行包。交付时同时提供已审核的 QQ 仓库提交，解压或克隆为同级 `dot-lark-bridge/` 和 `dot-qq-bridge/`，保留 QQ 仓库内的 `packages/dot-bridge-transport/`。两仓库各自保留锁定提交，交接时记录两者 SHA；不依赖第三个 Git 外 shared 目录。`config/tunnel-service.readiness.yaml` 仅包含公开占位模板，真实 Tunnel ID 和文件引用应写入仓库外的私有副本。
