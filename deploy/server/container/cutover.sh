#!/usr/bin/env bash
# P2 切流：宿主 dsh-web.service → 容器 dsh-web-container.service（含自动回滚）
# 用法（root）：bash deploy/server/container/cutover.sh
# P2 切流：dsh-web.service (宿主) → dsh-web-container.service (容器)
set -euo pipefail

LOG=/var/log/dsh-web/web.log
NEW_PORT=3090
PASS=$(sed -n 's/^password=//p' /root/dsh-secrets/login.txt)

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; }

rollback() {
  log "回滚到宿主模式"
  rm -f /etc/systemd/system/dsh-gate.service.d/override.conf
  systemctl daemon-reload
  systemctl disable --now dsh-web-container >/dev/null 2>&1 || true
  podman rm -f dsh-web >/dev/null 2>&1 || true
  systemctl enable --now dsh-web >/dev/null 2>&1 || true
  systemctl restart dsh-gate
  sleep 3
  log "回滚完成：$(systemctl is-active dsh-web dsh-gate | tr '\n' ' ')"
  exit 1
}

log "1) 安装容器单元"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install -m 644 "$SCRIPT_DIR/dsh-web-container.service" /etc/systemd/system/dsh-web-container.service
systemctl daemon-reload

log "2) 停用旧宿主服务（保留单元用于回滚）"
podman rm -f dsh-web >/dev/null 2>&1 || true
systemctl disable --now dsh-web >/dev/null 2>&1 || true

log "3) 启动容器服务"
systemctl enable --now dsh-web-container >/dev/null 2>&1 || { journalctl -u dsh-web-container -n 30 --no-pager -o cat; rollback; }
# 注意：rootful podman 通过 DNAT 发布端口，ss 看不到 LISTEN，改用端口映射 + HTTP 探测
READY=0
for _ in $(seq 1 45); do
  if podman ps --format '{{.Names}}' 2>/dev/null | grep -qx dsh-web \
     && podman port dsh-web 2>/dev/null | grep -q "127.0.0.1:${NEW_PORT}" \
     && curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${NEW_PORT}/" | grep -qE '^(401|303|302|200)$'; then
    READY=1; break
  fi
  sleep 2
done
[ "$READY" = "1" ] || { journalctl -u dsh-web-container -n 40 --no-pager -o cat; rollback; }

log "4) 让 dsh-gate 指向容器端口 $NEW_PORT"
install -d /etc/systemd/system/dsh-gate.service.d
printf '[Service]\nEnvironment=DSH_UPSTREAM_PORT=%s\n' "$NEW_PORT" > /etc/systemd/system/dsh-gate.service.d/override.conf
systemctl daemon-reload
systemctl restart dsh-gate
for _ in $(seq 1 20); do ss -tln | grep -q ':3081 ' && break; sleep 1; done

log "5) 端到端验证"
sleep 3
CODE_LOGIN=$(curl -sk -o /dev/null -w '%{http_code}' https://aecci.net:8443/login --resolve aecci.net:8443:127.0.0.1)
rm -f /tmp/cut.jar
CODE_POST=$(curl -sk -o /dev/null -w '%{http_code}' -c /tmp/cut.jar -X POST https://aecci.net:8443/login \
  -H 'Content-Type: application/json' -d "{\"username\":\"dsh\",\"password\":\"$PASS\"}" --resolve aecci.net:8443:127.0.0.1)
CODE_APP=$(curl -sk -o /tmp/cut.html -w '%{http_code}' -b /tmp/cut.jar -c /tmp/cut.jar -L -H 'Accept: text/html' https://aecci.net:8443/ --resolve aecci.net:8443:127.0.0.1)
TITLE=$(grep -oE '<title>[^<]*</title>' /tmp/cut.html | head -1)
log "login页=$CODE_LOGIN 登录=$CODE_POST 应用=$CODE_APP $TITLE"
if [ "$CODE_LOGIN" != "200" ] || [ "$CODE_POST" != "200" ] || [ "$CODE_APP" != "200" ]; then
  journalctl -u dsh-web-container -n 40 --no-pager -o cat
  rollback
fi

log "6) 容器内能力检查"
podman exec dsh-web bwrap --version
podman exec dsh-web sh -c 'id; grep -E "CapEff|NoNewPrivs" /proc/1/status' | sed 's/^/    /'
for p in /etc/dsh-gate /var/lib/dsh-gate /etc/nginx /home/wwwroot; do
  podman exec dsh-web test -e "$p" && echo "    $p: 可见 ❌" || echo "    $p: 不可见 ✅"
done

log "7) 其它入口不受影响"
curl -s -o /dev/null -w '    chat-demo: %{http_code}\n' https://aecci.net/
systemctl is-active dsh-web-container dsh-gate nginx | sed 's/^/    /'

log "切流完成（旧 dsh-web.service 已 disable，未删除，可随时回滚）"
