#!/usr/bin/env bash
# DeepSeek Harness 服务器部署安装脚本（server 分支）
# 组成：dsh web（回环 :3080）+ dsh-gate 登录页/会话认证反代（回环 :3081）+ nginx TLS 入口（:8443）
# 用法（root）：
#   sudo DOMAIN=example.com PUBLIC_PORT=8443 bash deploy/server/install.sh
set -euo pipefail

APP_USER=${APP_USER:-dsh}
APP_DIR=${APP_DIR:-/opt/dsh/app}
DSH_HOME=${DSH_HOME:-/opt/dsh/data}
TOOLCHAIN_DIR=${TOOLCHAIN_DIR:-/opt/dsh/toolchain}
SECRET_DIR=${SECRET_DIR:-/root/dsh-secrets}
REPO_URL=${REPO_URL:-https://github.com/clearnature/deepseek-harness.git}
BRANCH=${BRANCH:-server}
NODE_VERSION=${NODE_VERSION:-24.14.0}
PNPM_VERSION=${PNPM_VERSION:-12.18.0}
DOMAIN=${DOMAIN:-aecci.net}
PUBLIC_PORT=${PUBLIC_PORT:-8443}
UPSTREAM_PORT=${UPSTREAM_PORT:-3080}
GATE_PORT=${GATE_PORT:-3081}
HOST=${HOST:-127.0.0.1}
TLS_CERT=${TLS_CERT:-/etc/nginx/ssl/${DOMAIN}.crt}
TLS_KEY=${TLS_KEY:-/etc/nginx/ssl/${DOMAIN}.key}
GATE_LIB=${GATE_LIB:-/usr/local/lib/dsh-gate}
GATE_ETC=${GATE_ETC:-/etc/dsh-gate}
GATE_USER=${GATE_USER:-dsh-gate}
SHARED_GROUP=${SHARED_GROUP:-dsh-shared}
GATE_STATE_NAME=${GATE_STATE_NAME:-dsh-gate}
GATE_STATE_DIR=${GATE_STATE_DIR:-/var/lib/${GATE_STATE_NAME}}
WEB_LOG_DIR=${WEB_LOG_DIR:-/var/log/dsh-web}
NODE_BIN=${NODE_BIN:-/usr/local/bin/node}
NODE_VERSION=${NODE_VERSION:-24.22.3}
EGRESS_PORT=${EGRESS_PORT:-3128}
GH_VERSION=${GH_VERSION:-2.106.0}
LOGIN_USER=${LOGIN_USER:-dsh}
SERVICE_NAME=${SERVICE_NAME:-dsh-web}
GATE_SERVICE_NAME=${GATE_SERVICE_NAME:-dsh-gate}
BUILD_MEMORY_MB=${BUILD_MEMORY_MB:-3072}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
USER_HOME="/opt/${APP_USER}"
PATH_TOOLCHAIN="$TOOLCHAIN_DIR/node/bin:$TOOLCHAIN_DIR/npm/bin:/usr/local/bin:/usr/bin:/bin"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
as_user() { runuser -u "$APP_USER" -- env HOME="$USER_HOME" DSH_HOME="$DSH_HOME" PATH="$PATH_TOOLCHAIN" bash -lc "$1"; }
sed_template() {
  sed -e "s|__APP_USER__|$APP_USER|g" -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__USER_HOME__|$USER_HOME|g" -e "s|__DSH_HOME__|$DSH_HOME|g" \
      -e "s|__TOOLCHAIN_DIR__|$TOOLCHAIN_DIR|g" -e "s|__DOMAIN__|$DOMAIN|g" \
      -e "s|__PUBLIC_PORT__|$PUBLIC_PORT|g" -e "s|__UPSTREAM_PORT__|$UPSTREAM_PORT|g" \
      -e "s|__GATE_PORT__|$GATE_PORT|g" -e "s|__UPSTREAM_PORT_GATE__|$GATE_PORT|g" \
      -e "s|__HOST__|$HOST|g" -e "s|__TLS_CERT__|$TLS_CERT|g" -e "s|__TLS_KEY__|$TLS_KEY|g" \
      -e "s|__GATE_LIB__|$GATE_LIB|g" -e "s|__GATE_ETC__|$GATE_ETC|g" \
      -e "s|__GATE_USER__|$GATE_USER|g" -e "s|__SHARED_GROUP__|$SHARED_GROUP|g" \
      -e "s|__GATE_STATE_NAME__|$GATE_STATE_NAME|g" -e "s|__GATE_STATE_DIR__|$GATE_STATE_DIR|g" \
      -e "s|__WEB_LOG_DIR__|$WEB_LOG_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
      "$1"
}

[ "$(id -u)" -eq 0 ] || die "请以 root 运行"
for template in dsh-web.service dsh-gate.service dsh-egress.service nginx-dsh-web.conf gate/server.mjs gate/admin.mjs egress/squid-host.conf; do
  [ -f "$SCRIPT_DIR/$template" ] || die "缺少模板 $SCRIPT_DIR/$template"
done
command -v nginx >/dev/null || die "未安装 nginx"
[ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ] || die "证书不存在: $TLS_CERT / $TLS_KEY"
command -v runuser >/dev/null || die "缺少 runuser（util-linux）"

# 依赖：bubblewrap（DSH 执行沙箱后端）、系统 Node（供 dsh-gate 使用，必须是 root 所有）
if ! command -v bwrap >/dev/null; then
  log "安装 bubblewrap（DSH bash 沙箱后端）"
  dnf install -y bubblewrap >/dev/null || die "bubblewrap 安装失败"
fi

# 宿主工具（agent 编程环境）+ 宿主白名单代理
log "安装宿主工具与白名单代理（squid）"
dnf install -y jq ripgrep unzip zip gcc gcc-c++ gcc-gfortran make python3-pip squid ninja-build lld lldb >/dev/null || die "工具/代理安装失败"

# gh 最新预编译二进制（GitHub Releases）
log "安装 GitHub CLI ${GH_VERSION}（Releases 预编译）"
GH_TARBALL="gh_${GH_VERSION}_linux_amd64.tar.gz"
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TARBALL}" -o "/tmp/${GH_TARBALL}" \
  && tar -xzf "/tmp/${GH_TARBALL}" -C /tmp \
  && install -m 755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/${GH_TARBALL}" "/tmp/gh_${GH_VERSION}_linux_amd64" \
  || die "gh 安装失败"
# 统一 Node：安装官方 24.x 到 /usr/local（root 所有，dsh-web/dsh-gate 共用同一版本）
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "^v24\."; then
  log "安装 Node ${NODE_VERSION} 到 /usr/local"
  mkdir -p /usr/local/lib/nodejs
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
    && rm -f /tmp/node.tar.xz \
    || die "Node 下载/解压失败"
  for b in node npm npx corepack; do
    ln -sfn "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-x64/bin/${b}" "/usr/local/bin/${b}"
  done
fi
[ -x /usr/local/bin/node ] || die "Node 未就绪"
if ! /usr/local/bin/pnpm --version >/dev/null 2>&1; then
  log "安装全局 pnpm 12.18.0 / tsc 7.1.0-beta"
  /usr/local/bin/node /usr/local/bin/npm install -g --prefix /usr/local --allow-scripts=pnpm pnpm@12.18.0 typescript@7.1.0-beta >/dev/null \
    || die "pnpm/tsc 安装失败"
fi

# ---------------- 1. 用户与目录 ----------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "创建系统用户 $APP_USER"
  useradd -m -d "$USER_HOME" -s /bin/bash "$APP_USER"
  usermod -L "$APP_USER" 2>/dev/null || true
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$USER_HOME" "$DSH_HOME"
install -d -m 700 "$SECRET_DIR"

# 网关独立用户 + 共享组（launch token 日志只读共享）
getent group "$GATE_USER" >/dev/null || groupadd --system "$GATE_USER"
getent group "$SHARED_GROUP" >/dev/null || groupadd --system "$SHARED_GROUP"
id "$GATE_USER" >/dev/null 2>&1 || useradd --system --gid "$GATE_USER" \
  --home-dir "$GATE_STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$GATE_USER"
usermod -aG "$SHARED_GROUP" "$APP_USER"
usermod -aG "$SHARED_GROUP" "$GATE_USER"
install -d -o "$GATE_USER" -g "$GATE_USER" -m 750 "$GATE_STATE_DIR"

# ---------------- 2. 独立 toolchain ----------------
if [ ! -x "$TOOLCHAIN_DIR/node/bin/node" ]; then
  log "安装 Node v$NODE_VERSION 到 $TOOLCHAIN_DIR"
  mkdir -p "$TOOLCHAIN_DIR"
  TMP=$(mktemp -d)
  URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSL --max-time 600 "$URL" -o "$TMP/node.tar.xz" || die "Node 下载失败"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP"
  mv "$TMP/node-v${NODE_VERSION}-linux-x64" "$TOOLCHAIN_DIR/node"
  rm -rf "$TMP"
fi
chown -R "$APP_USER:$APP_USER" "$TOOLCHAIN_DIR"
if [ ! -x "$TOOLCHAIN_DIR/npm/bin/pnpm" ]; then
  log "安装 pnpm v$PNPM_VERSION"
  as_user "$TOOLCHAIN_DIR/node/bin/npm config set prefix $TOOLCHAIN_DIR/npm --location=user"
  as_user "$TOOLCHAIN_DIR/node/bin/npm install -g pnpm@${PNPM_VERSION}"
fi

# ---------------- 3. 代码 ----------------
if [ -d "$APP_DIR/.git" ]; then
  log "更新代码 $APP_DIR（origin/$BRANCH）"
  as_user "cd $APP_DIR && git fetch --depth 1 origin $BRANCH && git checkout -f FETCH_HEAD"
else
  log "克隆 $REPO_URL 分支 $BRANCH 到 $APP_DIR"
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  as_user "git clone --depth 1 -b $BRANCH $REPO_URL $APP_DIR"
fi

# ---------------- 4. 构建 ----------------
log "安装依赖并构建（约 3-6 分钟）"
as_user "cd $APP_DIR && pnpm install --frozen-lockfile"
as_user "cd $APP_DIR && NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB pnpm run build:artifacts"

# ---------------- 5. 登录门禁程序（root 所有，agent 不可写） ----------------
log "安装 dsh-gate 到 $GATE_LIB"
install -d -o root -g root -m 755 "$GATE_LIB"
install -o root -g root -m 644 "$SCRIPT_DIR/gate/server.mjs" "$GATE_LIB/server.mjs"
install -o root -g root -m 755 "$SCRIPT_DIR/gate/admin.mjs" "$GATE_LIB/admin.mjs"

install -d -o root -g "$GATE_USER" -m 750 "$GATE_ETC"
if [ ! -f "$GATE_ETC/users.json" ]; then
  printf '{"users":[]}\n' > "$GATE_ETC/users.json"
fi
chown root:"$GATE_USER" "$GATE_ETC/users.json"
chmod 640 "$GATE_ETC/users.json"

PASS_FILE="$SECRET_DIR/login.txt"
if [ -f "$PASS_FILE" ]; then
  LOGIN_PASS=$(sed -n 's/^password=//p' "$PASS_FILE")
else
  LOGIN_PASS=$(python3 -c "import secrets; a='abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; print(''.join(secrets.choice(a) for _ in range(18)))")
  printf 'username=%s\npassword=%s\n' "$LOGIN_USER" "$LOGIN_PASS" > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
fi
DSH_GATE_USERS="$GATE_ETC/users.json" DSH_GATE_PASSWORD="$LOGIN_PASS" \
  "$NODE_BIN" "$GATE_LIB/admin.mjs" set-user "$LOGIN_USER"
# admin 以 root 写文件后属主会变回 root:root，这里恢复分组可读
chown root:"$GATE_USER" "$GATE_ETC/users.json"
chmod 640 "$GATE_ETC/users.json"

# ---------------- 6. 共享日志目录（gate 读 launch token；agent 只读） ----------------
install -d -o root -g "$SHARED_GROUP" -m 750 "$WEB_LOG_DIR"
install -o root -g "$SHARED_GROUP" -m 640 /dev/null "$WEB_LOG_DIR/web.log"

# ---------------- 7. systemd 单元 ----------------
log "安装 systemd 单元"
sed_template "$SCRIPT_DIR/dsh-web.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
sed_template "$SCRIPT_DIR/dsh-gate.service" > "/etc/systemd/system/${GATE_SERVICE_NAME}.service"
install -d -m 755 /etc/dsh-egress
sed_template "$SCRIPT_DIR/egress/squid-host.conf" > /etc/dsh-egress/squid.conf
install -d -o squid -g squid /var/spool/squid /var/log/squid
runuser -u squid -- /usr/sbin/squid -z -f /etc/dsh-egress/squid.conf >/dev/null 2>&1 || true
sed_template "$SCRIPT_DIR/dsh-egress.service" > /etc/systemd/system/dsh-egress.service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" "$GATE_SERVICE_NAME" dsh-egress >/dev/null

# ---------------- 8. nginx 入口 ----------------
log "安装 nginx 入口 :$PUBLIC_PORT"
NGINX_CONF=/etc/nginx/conf.d/dsh-web.conf
NGINX_BACKUP=""
if [ -f "$NGINX_CONF" ]; then
  NGINX_BACKUP="${NGINX_CONF}.bak.$(date +%s)"
  cp -a "$NGINX_CONF" "$NGINX_BACKUP"
fi
sed_template "$SCRIPT_DIR/nginx-dsh-web.conf" > "$NGINX_CONF"
if ! nginx -t; then
  log "nginx -t 失败，回滚入口配置"
  if [ -n "$NGINX_BACKUP" ]; then mv -f "$NGINX_BACKUP" "$NGINX_CONF"; else rm -f "$NGINX_CONF"; fi
  die "nginx 配置未通过校验，已回滚"
fi
rm -f "$NGINX_BACKUP"
systemctl reload nginx

# ---------------- 9. 防火墙（可选） ----------------
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  log "firewalld 放行 $PUBLIC_PORT/tcp"
  firewall-cmd --permanent --add-port="$PUBLIC_PORT/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
fi

# ---------------- 10. 启动 ----------------
log "启动 $SERVICE_NAME / $GATE_SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
for _ in $(seq 1 90); do ss -tln 2>/dev/null | grep -q ":$UPSTREAM_PORT " && break; sleep 2; done
systemctl restart dsh-egress
systemctl restart "$GATE_SERVICE_NAME"
for _ in $(seq 1 30); do ss -tln 2>/dev/null | grep -q ":$GATE_PORT " && break; sleep 1; done

# 出站白名单：按 uid 限制直连，只允许 lo + DNS（必须走代理）
if [ -x "$SCRIPT_DIR/egress-firewall.sh" ]; then
  log "应用出站白名单（按 uid）"
  "$SCRIPT_DIR/egress-firewall.sh" "$APP_USER" || log "警告：出站防火墙规则未完全应用"
fi

cat <<EOF

============================================================
DeepSeek Harness 部署完成（登录页 + 会话认证）
------------------------------------------------------------
访问入口   : https://${DOMAIN}:${PUBLIC_PORT}/
登录账号   : ${LOGIN_USER}
登录密码   : ${LOGIN_PASS}
密码文件   : ${PASS_FILE}（改密码见 deploy/server/README.md）
服务状态   : systemctl status ${SERVICE_NAME} ${GATE_SERVICE_NAME}
日志       : journalctl -u ${GATE_SERVICE_NAME} -n 100 --no-pager
============================================================
EOF
