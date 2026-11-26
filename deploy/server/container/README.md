# P2/P3：DSH Web 容器化 + 出站白名单（✅ 2026-11-25 已切流）

目标：把 `dsh web`（含 agent 执行的命令）关进容器，**只挂载源码（只读）、DSH_HOME、workspace**，
宿主其余路径一律不可见。这样即使 agent 通过 `danger-full-access` 审批或利用 DSH 读写策略
写到容器内任意位置，也接触不到宿主文件（nginx 配置、网关口令、其它服务数据等）。

## 线上状态（P2 + P3）

- `dsh-web-container.service` **active/enabled**：容器只在 `dsh-int`（`--internal`，10.89.0.0/24）网络，固定 IP `10.89.0.50`，**无直接出站**
- `dsh-egress-container.service` **active/enabled**：squid 白名单代理，双网卡 `dsh-int`(10.89.0.21) + 默认网络出网；DSH 通过 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 走它
- `dsh-gate` 直连 `10.89.0.50:3080`（内部网络不支持端口发布，drop-in 指定 upstream）
- DSH_HOME 复用 `/opt/dsh/data`（挂到容器 `/home/node`，`DSH_HOME=/home/node`）；工作区 `/opt/dsh/work` **按宿主同路径**挂进容器
- 镜像：`dsh-web-p2:latest`（246MB）、`dsh-egress:latest`

### P3 出站白名单

### 容器内编程环境（镜像内预装，非宿主共享）

宿主 `/usr`、`/opt/dsh/toolchain` 不进容器。容器内只有镜像自带工具，且 **agent 无法自行 apt 安装**
（uid=1000 无 root/sudo；且 Debian 源不在白名单）。当前预装：

```text
node 24 + npm/npx    git 2.47    curl 8.14    jq 1.7
unzip / zip          ripgrep 13  python3 3.13 + pip3 + venv   gcc/g++ 14.2（Debian 13 预编译）+ make 4.4 + libc6-dev
bubblewrap 0.8       bash/coreutils
```

- GitHub CLI: `gh` 2.106.0（GitHub Releases 官方预编译二进制，非 Debian 源旧版 2.46）
- 编译器为 Debian 13 官方预编译包（构建期 `apt-get install gcc g++ make libc6-dev`），非源码自编；
  容器内 `gcc -O2 -o app app.c`、`g++`、`make` 实测可用（C 与 C++23 `<format>`/`<print>` 均编译运行通过），镜像体积约 660MB（Debian 13 基础镜像）。
- 回滚镜像保留为 `dsh-web-p2:bookworm`（Debian 12 + GCC 12.2）。

- npm 安装：`npm install`（registry 白名单）；全局目录不可写，装到工作区
- pip 安装：`pip3 install --user xxx`（已设 `PIP_BREAK_SYSTEM_PACKAGES=1`；PyPI 已入白名单）；或 `python3 -m venv`
- 无编译器（gcc/make/go/rust/java）与编辑器（vim），按需再加

允许域名（`container/egress/squid.conf`，只放 80/443）：

```text
.deepseek.com  .opencode.ai  .github.com  .githubusercontent.com
.npmjs.org  .nodejs.org  .npmmirror.com  .pypi.org  .pythonhosted.org
```

实测：容器内 `fetch('https://api.deepseek.com/models') → 401`（通）、`fetch('https://example.com') → BLOCKED`、
`net.connect(443,'1.1.1.1') → ENETUNREACH`（绕过代理直连被阻断）。

**加白名单域名**：编辑 `container/egress/squid.conf` → `podman build -t dsh-egress:latest deploy/server/container/egress/`
→ `systemctl restart dsh-egress-container` → **`systemctl restart dsh-web-container`**（代理容器 IP 可能变化，DSH 启动脚本会在启动时重新解析）。

**代价**：agent 的任意网页访问能力被限制在白名单内（这是 P3 的目的）；容器内 DNS 在 internal 网络不可用（代理按域名 CONNECT，不需要容器侧 DNS）。
**回滚到 P2（直接出网）**：把 `run-dsh-web.sh` 换回 `.p2` 备份（默认桥接 + `-p`），gate override 改回 `DSH_UPSTREAM_PORT=3090`，停用 egress 单元。

## P2 验证（2026-11-25，服务器实测）

| 检查 | 结果 |
| --- | --- |
| 容器启动 + token 生成 | ✅ `dsh web: listening on 10.88.0.6` + launch URL |
| 页面/token 交换 | ✅ 303 → 会话 Cookie → 首页 200，标题 `DSH Local Build` |
| 容器内 bubblewrap | ✅ 0.8.0，`bwrap --ro-bind / / ... /bin/true` 通过（命令沙箱可用） |
| 容器出站网络 | ✅ 可访问 LLM API（`api.deepseek.com` 返回 401，说明链路通） |
| 宿主路径可见性 | ✅ `/etc/dsh-gate`、`/var/lib/dsh-gate`、`/opt/dsh/data`、`/home/wwwroot`、`/etc/nginx` 均不可见 |
| 容器内身份/权限 | ✅ `uid=1000(node)`、`CapEff=0000…`、`NoNewPrivs=1` |
| 端口发布 | ✅ `3080/tcp -> 127.0.0.1:3090`（仅回环） |

## 文件

```text
container/
  Containerfile                  node24-slim + bubblewrap
  run-dsh-web.sh                 运行脚本（systemd 调用）
  dsh-web-container.service      系统级 systemd 单元（rootful podman）
  README.md                      本文件
```

## 加固属性（2026-11-25 追加）

| 项 | 配置 |
| --- | --- |
| userns 重映射 | 容器 root→宿主 subuid 100000；node(1000)→宿主 1000（内核逃逸落点不再是 root） |
| 资源限额 | `--memory=1300m --memory-swap=1500m --cpus=1.5 --pids-limit=512` |
| seccomp | `seccomp=unconfined`（容器内 bwrap 需要 `clone(CLONE_NEWUSER)`；外层容器 + cap-drop ALL + no-new-privileges 仍为边界） |
| bash 沙箱 | 已恢复：容器内 bwrap 探测通过，DSH 的 `workspace-write` 继续生效 |
| 容器→宿主横向 | firewalld 直连规则：只放行容器→宿主 DNS(53)，其余 NEW 连接 DROP；已建立连接回包放行（状态化） |

## 踩坑与约束（实测）

1. **DSH 拒绝 `--host 0.0.0.0`**：容器启动脚本必须绑定容器自身 IP（`hostname -i` 第一项）。
2. **rootful podman 的端口发布走 DNAT**，宿主上 `ss -tln` **看不到** 3090 的 LISTEN；就绪检查要用
   `podman port dsh-web` + `curl 127.0.0.1:3090`，否则会误判失败（本目录 `cutover.sh` 已修正）。
3. **工作区必须按宿主同路径挂载**：DSH 在 `storages/workspace.json` 里记录工作区绝对路径
   （本机为 `/opt/dsh/work`）；若挂到 `/workspace`，agent 工具写入会因路径不存在而失败。
4. DSH_HOME 复用旧目录时，容器挂载点为 `/home/node`，且 `DSH_HOME=/home/node`（不是 `/home/node/.dsh`）。
5. **firewalld 直连规则必须状态化**：无状态 `-j DROP` 会把「宿主→容器」连接的回包一起丢掉（表现为 gate 502）。
   正确写法：`-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` + `-m conntrack --ctstate NEW -j DROP`。
6. 内部网络（`--internal`）的 aardvark DNS 不工作，容器内 DNS 解析失败；**不影响模型调用**
   （出站经 squid 按域名 CONNECT，由代理侧解析），但容器内 npm/agent 直连域名会失败。
5. 容器根文件系统不设 `--read-only`（agent 需要极小范围写入）；安全边界靠 **只挂载 3 个路径 + cap-drop ALL + no-new-privileges + 非 root**。

## 部署（切换步骤）

```sh
# 1) 构建镜像
podman build -t dsh-web-p2:latest /opt/dsh/app/deploy/server/container/

# 2) 安装运行脚本与单元
install -d /usr/local/lib/dsh-container
install -m 755 /opt/dsh/app/deploy/server/container/run-dsh-web.sh /usr/local/lib/dsh-container/
install -m 644 /opt/dsh/app/deploy/server/container/dsh-web-container.service /etc/systemd/system/
systemctl daemon-reload

# 3) 迁移 DSH_HOME（二选一）
#    A. 兼容旧会话/已填 Key：挂载现有目录（仍与旧服务同 uid，容器内可读写）
#       DSH_HOME_DIR=/opt/dsh/data
#    B. 干净隔离（推荐）：新目录，切换后到 Web UI 里重新填写模型 Key
#       DSH_HOME_DIR=/opt/dsh/container-home  （默认）

# 4) 切换（保留回滚：旧单元文件不删，先停用）
systemctl disable --now dsh-web
systemctl enable --now dsh-web-container

# 5) 让 dsh-gate 指向容器发布端口（3090）
systemctl edit dsh-gate    # 加一行：Environment=DSH_UPSTREAM_PORT=3090
systemctl restart dsh-gate
```

验证：登录 `https://<domain>:8443/` → 页面加载 → 发一条消息确认模型调用正常。

回滚：

```sh
systemctl disable --now dsh-web-container
systemctl enable --now dsh-web
systemctl edit dsh-gate    # 删除 DSH_UPSTREAM_PORT 覆盖（回到 3080）
systemctl restart dsh-gate
```

## 明确的能力边界（不要误解）

- **不能** 防住「agent 读取 DSH_HOME 里的模型 Key」：DSH 进程本身需要用它，同容器同 uid 的
  agent 仍可读。要根治需要：一次性 VM / 不落盘凭据注入 / 把模型调用代理到容器外（DSH 不支持）。
- 容器隔离针对的是**宿主文件与服务**：nginx 配置、网关用户库/会话、其它站点、系统目录。
- 需要内核支持 userns；bubblewrap 在容器内依赖它（已验证可用）。若发行版禁 userns，需换
  `--security-opt seccomp=unconfined`（会削弱隔离）或改用宿主 bwrap + 只读挂载的方案。

## Rootless 升级建议（可选）

`/etc/subuid`、`/etc/subgid` 已为 `dsh` 配置（524288:65536）。建议后续改为：

```sh
loginctl enable-linger dsh
# dsh 用户下：mkdir -p ~/.config/containers/systemd
# 放置 rootless quadlet：dsh-web.container（User=dsh 语义由 rootless 保证）
systemctl --user daemon-reload && systemctl --user start dsh-web
```

rootless 下运行脚本需 `User=dsh` 且 `Environment=XDG_RUNTIME_DIR=/run/user/1000`；镜像需以 dsh
身份重新 pull/build（存储隔离在 `~/.local/share/containers`）。当前草稿先用 rootful 保证可运行，
切 rootless 前需在目标机复测端口发布与 userns 嵌套（本次未验证）。
