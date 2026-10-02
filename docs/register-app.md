# 官方扫码注册与本人单聊配对

已提供可审查、带显式执行门槛的操作向导。**本次没有执行真实注册、展示真实验证链接、取回凭据、配对账户或远程探测。** 测试中的 SDK 注册/连接均为注入的假实现。

先运行无网络、无写入的预览：

```powershell
npm.cmd run setup -- plan
```

默认命令也是 plan。源码在 [setup.js](../src/setup.js)；它调用官方 [Node SDK registerApp](https://github.com/larksuite/node-sdk#app-registration)，而不是模拟用户登录。开始任何真实命令前，应由主线程取得 [最少授权](authorization.md)。`--confirm-*` 仅表示操作者已获得该授权，不是替用户授权。

## 注册：一次扫码创建一个应用

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

`preset=false` 采用最小机器人基底，避免 SDK 默认模板的额外业务权限。没有 user scopes、Cookie、用户 token、通讯录、日历、群聊权限或选定已有应用的入口。确认页面允许用户修改，操作者仍须核对实际授予的权限，向导不声称已自动核实全部权限。

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
