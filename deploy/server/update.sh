#!/usr/bin/env bash
# DeepSeek Harness 服务器更新脚本（server 分支）
# 用法（root）：sudo bash /opt/dsh/app/deploy/server/update.sh
set -euo pipefail

APP_USER=${APP_USER:-dsh}
APP_DIR=${APP_DIR:-/opt/dsh/app}
DSH_HOME=${DSH_HOME:-/opt/dsh/data}
TOOLCHAIN_DIR=${TOOLCHAIN_DIR:-/opt/dsh/toolchain}
BRANCH=${BRANCH:-server}
SERVICE_NAME=${SERVICE_NAME:-dsh-web}
GATE_SERVICE_NAME=${GATE_SERVICE_NAME:-dsh-gate}
SHARED_GROUP=${SHARED_GROUP:-dsh-shared}
WEB_LOG_DIR=${WEB_LOG_DIR:-/var/log/dsh-web}
NODE_BIN=${NODE_BIN:-/usr/bin/node}
UPSTREAM_PORT=${UPSTREAM_PORT:-3080}
GATE_PORT=${GATE_PORT:-3081}
BUILD_MEMORY_MB=${BUILD_MEMORY_MB:-3072}

USER_HOME="/opt/${APP_USER}"
PATH_TOOLCHAIN="$TOOLCHAIN_DIR/node/bin:$TOOLCHAIN_DIR/npm/bin:/usr/local/bin:/usr/bin:/bin"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
as_user() { runuser -u "$APP_USER" -- env HOME="$USER_HOME" DSH_HOME="$DSH_HOME" PATH="$PATH_TOOLCHAIN" bash -lc "$1"; }

[ "$(id -u)" -eq 0 ] || die "请以 root 运行"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是 git 仓库，请先运行 install.sh"

log "拉取 origin/$BRANCH"
as_user "cd $APP_DIR && git fetch --depth 1 origin $BRANCH && git checkout -f FETCH_HEAD"

log "安装依赖并构建（NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB）"
as_user "cd $APP_DIR && pnpm install --frozen-lockfile"
as_user "cd $APP_DIR && NODE_OPTIONS=--max-old-space-size=$BUILD_MEMORY_MB pnpm run build:artifacts"

log "校验依赖与日志目录"
command -v bwrap >/dev/null || dnf install -y bubblewrap
[ -x "$NODE_BIN" ] || dnf install -y nodejs
install -d -o root -g "$SHARED_GROUP" -m 750 "$WEB_LOG_DIR"
install -o root -g "$SHARED_GROUP" -m 640 /dev/null "$WEB_LOG_DIR/web.log"

log "同步 dsh-gate 程序（若部署资产有更新）"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GATE_LIB=${GATE_LIB:-/usr/local/lib/dsh-gate}
install -o root -g root -m 644 "$SCRIPT_DIR/gate/server.mjs" "$GATE_LIB/server.mjs"
install -o root -g root -m 755 "$SCRIPT_DIR/gate/admin.mjs" "$GATE_LIB/admin.mjs"

log "重启 $SERVICE_NAME / $GATE_SERVICE_NAME"
systemctl restart dsh-egress 2>/dev/null || true
systemctl restart "$SERVICE_NAME"
for _ in $(seq 1 90); do ss -tln 2>/dev/null | grep -q ":$UPSTREAM_PORT " && break; sleep 2; done
systemctl restart "$GATE_SERVICE_NAME"
for _ in $(seq 1 30); do ss -tln 2>/dev/null | grep -q ":$GATE_PORT " && break; sleep 1; done

log "更新完成：$(as_user "cd $APP_DIR && git log --oneline -1")"
printf '登录入口: https://%s:%s/  （账号密码见 /root/dsh-secrets/login.txt）\n' \
  "${DOMAIN:-aecci.net}" "${PUBLIC_PORT:-8443}"
