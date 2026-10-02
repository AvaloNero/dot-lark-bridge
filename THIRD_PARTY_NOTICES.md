# 来源与依赖

仓库原有 MIT LICENSE（Copyright (c) 2026 A2KT）未修改。

通用 MCP 2.0、Standard Webhooks 签名、OAuth/JWKS、SSRF、SQLite 队列和相关回归设计来自同作者 [dot-qq-bridge](https://github.com/AvaloNero/dot-qq-bridge) 固定提交 `3578dd0bbc3c3fca12c610fb23c14d13ef77a193`，MIT。只通过 git show 读取该提交；没有读取/合并其正在修改的代码，也没有修改 QQ 工作树。本项目去除了 QQ callback、签名和发送协议，并增加飞书身份绑定与订阅代次/撤销竞争保护。

官方 [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) 1.74.0 通过 npm dependency 使用，不将其构建产物复制到本仓库源码。其许可证：MIT，Copyright (c) 2022 Lark Technologies Pte. Ltd.；npm 包自带完整 LICENSE。版本、传递依赖、包 integrity 与许可 metadata 在 `package-lock.json` 保存；分发含 node_modules 的运行镜像时应保留依赖各自许可证。

Node.js 内置 HTTP/HTTPS/crypto/sqlite/fs 用于本桥，MIT 条款不替代 Node.js 或其他运行环境自带许可。Standard Webhooks HMAC 按官方协议实现，没有拷贝第三方 standardwebhooks 包代码。

公开协议及文档引用集中在 [docs/protocol.md](docs/protocol.md)；本项目没有复制官方文档全文，没有使用其他桥接项目的 Cookie、用户令牌、账户凭据或模型私有记忆。
