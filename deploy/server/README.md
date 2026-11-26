# server 分支：服务器部署环境（DeepSeek Harness）

本分支 = `baseline` + 服务器部署资产（`deploy/server/`），**不修改任何 DSH 源码**。
把 `dsh web` 以「登录页 + 会话认证 + TLS + 沙箱隔离」的方式发布到 Linux 服务器。

```text
deploy/server/
  README.md                本文件
  install.sh               首次安装（用户 / toolchain / 构建 / 登录门禁 / nginx / systemd）
  update.sh                更新（拉取 → 构建 → 重启；同步 gate 程序）
  dsh-web.service          DSH 本体 systemd 模板（回环 :3080，沙箱 + 资源上限）
  dsh-gate.service         登录门禁 systemd 模板（回环 :3081）
  nginx-dsh-web.conf       nginx 入口模板（TLS + 安全响应头）
  gate/server.mjs          登录页 + 会话认证反向代理（零依赖 Node）
  gate/admin.mjs           账号管理（设置/删除登录密码）
```

## 当前生产形态（2026-11-26 起：宿主直跑）

为降低资源与维护成本、并消除 rootful podman 的逃逸落点风险，生产已从容器切回**宿主 systemd 直跑**：

- `dsh-web.service`：`User=dsh`（非 root，无 sudo 权限），systemd 沙箱加固
  （`ProtectSystem=strict`、`ReadWritePaths` 仅 DSH_HOME + work、`InaccessiblePaths` 隐藏
  `/etc/dsh-gate`、`/var/lib/dsh-gate`、`/etc/nginx`、`/etc/v2ray`、`/var/log/nginx`、`/root`，
  `CapabilityBoundingSet=`、`NoNewPrivileges`、`SystemCallFilter=@system-service`、
  `MemoryMax=1200M`、`CPUQuota=150%`、`TasksMax=512`）
- `dsh-egress.service`：宿主 squid，仅监听 `127.0.0.1:3128`，按域名白名单出网
- 出站：firewalld 按 `uid=dsh` 限制，只允许 lo（代理）+ DNS；squid 黑名单模式（公网放行、内网拦截）
- 入口不变：nginx `:443`（chat-demo）/`:8443`（DSH gate 登录）+ fail2ban + SSH
- 运行环境统一：Node **24.22.3**（`/usr/local/bin/node`，root 所有，dsh-web/dsh-gate 共用）、
  npm 11.19、pnpm **12.18.0**（全局）、tsc 全局 **7.1.0-beta**（仓库构建 API 用 6.0.3，TS7 编译走 `DSH_TSC_BIN`）；
  编译器 gcc/gfortran 14.4 / clang 22 / rust 1.97 / go 1.27 / cmake 3.31 / ninja
- 容器方案（`deploy/server/container/`）保留为**可选/历史方案**，当前未启用；镜像已清理

## 架构

```text
浏览器 --TLS(8443)--> nginx --HTTP--> dsh-gate(127.0.0.1:3081) --HTTP--> dsh web(127.0.0.1:3080)
                         │                    │
                         │                    ├─ /login 登录页（用户名+密码）
                         │                    ├─ scrypt 校验 + 30 天 HttpOnly/Secure/SameSite=Strict 会话
                         │                    ├─ 未登录 → 302 /login（API → 401）
                         │                    └─ 登录后自动完成 DSH launch token 交换，用户无需 token URL
                         └─ HSTS / nosniff / X-Frame-Options / Referrer-Policy，server_tokens off
```

## 安装

```sh
sudo DOMAIN=example.com PUBLIC_PORT=8443 bash deploy/server/install.sh
```

主要参数（均可用环境变量覆盖）：`APP_USER`、`APP_DIR=/opt/dsh/app`、`DSH_HOME=/opt/dsh/data`、
`TOOLCHAIN_DIR=/opt/dsh/toolchain`、`REPO_URL`、`BRANCH=server`、`NODE_VERSION`、`PNPM_VERSION`、
`DOMAIN`、`PUBLIC_PORT=8443`、`UPSTREAM_PORT=3080`、`GATE_PORT=3081`、`TLS_CERT`、`TLS_KEY`、
`LOGIN_USER=dsh`、`SECRET_DIR=/root/dsh-secrets`。

安装结束会打印登录账号密码，并保存到 `/root/dsh-secrets/login.txt`。

## 基本安全设计（清单）

| 层 | 措施 |
| --- | --- |
| 传输 | TLS 1.2/1.3、HSTS（含子域）、仅暴露 8443（其它端口不对外） |
| 口令 | 服务端只存 **scrypt 加盐哈希**（不存明文）；恒定时间比较；用户不存在时也做等价计算，防用户名枚举 |
| 会话 | 256-bit 随机 ID；Cookie `HttpOnly; Secure; SameSite=Strict`；30 天过期；服务端可撤销；登出即清 |
| CSRF | 会话 Cookie `SameSite=Strict` + 登录/登出使用同源 JSON POST |
| 暴力破解 | 同 IP 15 分钟内失败 5 次 → 锁定 5 分钟，返回 429 + `Retry-After`；登录成功/失败均记录审计日志（不含密码） |
| 重定向 | 登录后跳转只允许站内路径（`/` 开头且非 `//`），防开放重定向 |
| 登录页 | 独立 CSP（`default-src 'none'`，仅允许自身脚本/样式）、`noindex`、无任何外部资源 |
| 响应头 | `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`、`server_tokens off` |
| 最小暴露 | `dsh web` 与 `dsh-gate` 都只监听 `127.0.0.1`；公网入口只有 nginx |
| 进程隔离 | 两服务均以无密码用户 `dsh` 运行；systemd `ProtectSystem=strict` + `ReadWritePaths=/opt/dsh` + `PrivateTmp` + `NoNewPrivileges` + 空 capability + 资源上限 |
| 代码完整性 | `dsh-gate` 程序安装在 `/usr/local/lib/dsh-gate`（root 所有，agent 不可写）；账号文件 `/etc/dsh-gate/users.json` 为 `root:dsh 640`，agent 只能读不能改 |
| 网关隔离 | `dsh-gate` 使用**独立系统用户**；网关口令库（`/etc/dsh-gate/users.json`，root:dsh-gate 640）与会话（`/var/lib/dsh-gate`，0700）对 agent（uid `dsh`）不可读 |
| 执行沙箱 | 安装 `bubblewrap`；DSH 的 bash/命令工具走 bwrap（只读根 + workspace 可写），无内核后端时 fail-closed |
| 宿主进程权限 | `User=dsh` 非 root、不在 sudoers/wheel；`NoNewPrivileges` + 空 `CapabilityBoundingSet` |
| 资源限额 | systemd `MemoryMax=1200M / CPUQuota=150% / TasksMax=512`（宿主机仅 2GB） |
| 出站策略 | firewalld 按 `uid=dsh` 只放行 lo（127.0.0.1:3128 代理）+ DNS，其余直连 DROP；squid **黑名单模式**：放行公网 80/443，拦截内网/本机/链路本地 + 显式坏域名 |
| 日志防篡改 | launch token 日志 `/var/log/dsh-web/web.log` 由 root 持有（640:dsh-shared），agent 只读、不可写伪造 |
| 纵深防御 | DSH 自身仍有 launch token + 签名会话 Cookie；gate 只负责自动完成交换，用户无感 |
| 凭据存放 | 登录密码 `/root/dsh-secrets/login.txt`（600）；DSH 的服务端 API Key 由使用者在 UI 内填写，存 `DSH_HOME` 凭据文件（600） |

> ⚠️ 属限制而非保证：DSH 官方 `SAFETY.md` 明确其未经安全审计，能执行模型生成的命令。
> 隔离只能限制「写哪里、能访问什么」，不能阻止其在允许范围内执行命令。请勿共享账号，建议在 UI 内收紧工具审批。

## 域名与浏览器存储

- **统一只用一个入口**：nginx 模板会把 `www.<domain>` 和通过 IP 访问的 HTTPS 请求 301 到主域（8443 同理）。
  原因：`localStorage`（chat-demo 存 API Key）与 Cookie 都按 origin（协议+域名+端口）隔离，
  `aecci.net` / `www.aecci.net` / IP 是三份互不相通的存储，换入口会「看起来像密码丢了」。
- 登录页的密码本身**从不存浏览器**：服务端只存 scrypt 哈希，浏览器只持有 30 天会话 Cookie
  （HttpOnly，JS 读不到）。浏览器密码管理器是否记住密码取决于浏览器，登录表单已使用标准
  `method=post action=/login` + `autocomplete` 属性以兼容主流密码管理器。
- Cookie 采用 `SameSite=Lax`：跨站链接进入时仍保留会话，同时登出/登录等 POST 操作仍有 CSRF 防护。

## 安全加固记录

| 项 | 状态 | 说明 |
| --- | --- | --- |
| P0 轮换 | ✅ | 登录口令、全部会话、launch token 已轮换（模型 API Key 需使用者在 DSH UI 内自行轮换） |
| P1 拆用户 | ✅ | `dsh-gate` 独立系统用户；网关口令/会话对 agent 不可读；共享组仅用于只读 launch token 日志 |
| P4 执行沙箱 | ✅ | 安装 `bubblewrap` 0.10，DSH bash 工具恢复受控执行（只读根 + workspace 可写） |
| P2 容器化 | 🗄 **历史/可选** | 容器方案保留在 `container/`，2026-11-26 已切回宿主直跑并清理镜像；需要时可按 README 重建 |
| P3 出站策略 | ✅ **黑名单模式（2026-11-26 起）** | 宿主 squid 默认放行公网（LLM 查资料用），只拦内网/本机/云 metadata + 坏域名；firewalld uid 限制只允许走代理 |
| 读围栏 | ⏳ 策略 | DSH fs 层读不设围栏（设计如此）；敏感数据应移出 agent 可达范围 |

## TypeScript 7.1 构建（可选，性能优化）

仓库默认 `typescript@6.0.3` 负责构建脚本的 API（读 tsconfig），实际编译可指向 TS 7.1：

```sh
# TS7 装在 /opt/dsh/toolchain/tsc7（需含 @typescript/typescript-linux-x64 原生包）
DSH_TSC_BIN=/opt/dsh/toolchain/tsc7/node_modules/typescript/bin/tsc \
  NODE_OPTIONS=--max-old-space-size=3072 pnpm run build:artifacts
```

- `scripts/compile-referenced-projects.ts` 已支持 `DSH_TSC_BIN`（默认回退仓库内 tsc）
- 实测：TS 6.0.3 约 283s；TS 7.1 约 133s（峰值 RSS 1.52GB，2GB 宿主可完成 artifacts 构建）
- 注意：TS 7.1 全量 `pnpm run typecheck` 目前有 3 个测试文件的 TS2883 需补注解；host aggregate check 在 2GB 机器会 OOM

## 运维

```sh
systemctl status dsh-web dsh-gate
journalctl -u dsh-gate -n 100 --no-pager     # 登录审计 / 失败锁定
journalctl -u dsh-web  -n 100 --no-pager

# 更新（拉取 server 分支最新提交）
sudo bash /opt/dsh/app/deploy/server/update.sh

# 改登录密码（无需重启服务，下次登录生效）
sudo DSH_GATE_PASSWORD='新密码' \
  /opt/dsh/toolchain/node/bin/node /usr/local/lib/dsh-gate/admin.mjs set-user dsh
sudo chown root:dsh /etc/dsh-gate/users.json && sudo chmod 640 /etc/dsh-gate/users.json

# 强制所有会话下线（会话文件 /var/lib/dsh-gate/sessions.json）
sudo systemctl restart dsh-gate

# 确认执行沙箱后端可用（bwrap）
bwrap --version
sudo -u dsh bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp /bin/true && echo OK
```

## 已知限制

- 单账号；多人使用建议按需扩展为多账号 + 每人独立密码，或叠加 IP 白名单 / MFA。
- 登录会话保存在内存 + `/opt/dsh/data/gate-sessions.json`（600），重启不丢失登录态。
- 首次安装构建约 3-6 分钟（3 vCPU / 2 GB 内存实测），构建期内存紧张属正常。
- **剩余风险（需 P2/P3）**：DSH 的模型凭据 `.credentials.yaml` 与 agent 同 uid，agent 进程仍可读取
  （这是 DSH 自身设计；靠容器化 + 一次性 VM + 凭据注入才能根治）；出站流量未做白名单。
- dsh-gate 执行的是系统 Node（`/usr/bin/node`，root 所有），**不要**改回 agent 可写的 toolchain node，
  否则 agent 可替换二进制提权到 gate 用户。
- DSH 的 launch token 每次重启会变：gate 会自动读取新 token，无需人工介入。
