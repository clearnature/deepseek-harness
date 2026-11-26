#!/usr/bin/env bash
# P3 切流：DSH 容器 → 仅内部网络 + 白名单代理出站（含自动回滚）
set -uo pipefail

CH=/usr/local/lib/dsh-container
PASS=$(sed -n 's/^password=//p' /root/dsh-secrets/login.txt)
NEW_IP=10.89.0.50
NEW_PORT=3080

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }

rollback() {
  log "回滚到 P2（默认桥接网络 + 端口发布 3090）"
  systemctl disable --now dsh-egress-container >/dev/null 2>&1 || true
  [ -f "$CH/run-dsh-web.sh.p2" ] && cp -f "$CH/run-dsh-web.sh.p2" "$CH/run-dsh-web.sh"
  rm -f /etc/systemd/system/dsh-gate.service.d/override.conf
  printf '[Service]\nEnvironment=DSH_UPSTREAM_PORT=3090\n' > /etc/systemd/system/dsh-gate.service.d/override.conf
  systemctl daemon-reload
  systemctl restart dsh-web-container
  systemctl restart dsh-gate
  sleep 4
  log "回滚后：$(systemctl is-active dsh-web-container dsh-gate | tr '\n' ' ')"
  exit 1
}

log "1) 备份 P2 运行脚本"
[ -f "$CH/run-dsh-web.sh.p2" ] || cp -f "$CH/run-dsh-web.sh" "$CH/run-dsh-web.sh.p2"

log "2) 启动白名单代理容器"
podman rm -f dsh-egress >/dev/null 2>&1 || true
systemctl enable --now dsh-egress-container
PROXY_IP=""
for _ in $(seq 1 20); do
  PROXY_IP=$(podman inspect dsh-egress -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep '^10\.89\.' | head -1 || true)
  [ -n "$PROXY_IP" ] && break; sleep 2
done
[ -n "${PROXY_IP:-}" ] || { journalctl -u dsh-egress-container -n 20 --no-pager -o cat; rollback; }
log "代理地址：$PROXY_IP"

log "3) 切换 DSH 容器到内部网络"
systemctl stop dsh-web-container
systemctl restart dsh-web-container || rollback
READY=0
for _ in $(seq 1 45); do
  if podman ps --format '{{.Names}}' | grep -qx dsh-web \
     && curl -s -o /dev/null -m 3 -H 'Host: aecci.net:8443' -w '%{http_code}' "http://${NEW_IP}:${NEW_PORT}/" | grep -qE '^(401|303|302|200)$'; then
    READY=1; break
  fi
  sleep 2
done
[ "$READY" = "1" ] || { journalctl -u dsh-web-container -n 40 --no-pager -o cat; log "容器未就绪"; rollback; }

log "4) gate 直连容器内部 IP"
printf '[Service]\nEnvironment=DSH_UPSTREAM_HOST=%s\nEnvironment=DSH_UPSTREAM_PORT=%s\n' "$NEW_IP" "$NEW_PORT" > /etc/systemd/system/dsh-gate.service.d/override.conf
systemctl daemon-reload
systemctl restart dsh-gate
for _ in $(seq 1 15); do ss -tln | grep -q ':3081 ' && break; sleep 1; done

log "5) 端到端验证"
CODE_LOGIN=$(curl -sk -o /dev/null -w '%{http_code}' https://aecci.net:8443/login --resolve aecci.net:8443:127.0.0.1)
rm -f /tmp/p3.jar
CODE_POST=$(curl -sk -o /dev/null -w '%{http_code}' -c /tmp/p3.jar -X POST https://aecci.net:8443/login \
  -H 'Content-Type: application/json' -d "{\"username\":\"dsh\",\"password\":\"$PASS\"}" --resolve aecci.net:8443:127.0.0.1)
CODE_APP=$(curl -sk -o /tmp/p3.html -w '%{http_code}' -b /tmp/p3.jar -c /tmp/p3.jar -L -H 'Accept: text/html' https://aecci.net:8443/ --resolve aecci.net:8443:127.0.0.1)
log "login页=$CODE_LOGIN 登录=$CODE_POST 应用=$CODE_APP $(grep -oE '<title>[^<]*</title>' /tmp/p3.html | head -1)"
[ "$CODE_LOGIN" = "200" ] && [ "$CODE_POST" = "200" ] && [ "$CODE_APP" = "200" ] || { journalctl -u dsh-web-container -n 30 --no-pager -o cat; rollback; }

log "6) 出站白名单强制验证（容器内）"
podman exec dsh-web sh -c 'cat /etc/resolv.conf | head -3; env | grep -E "PROXY" | sed -E "s/(:3128)/:3128/"'
podman exec dsh-web node -e "
const test = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); console.log('  '+url+' -> '+r.status); }
  catch (e) { console.log('  '+url+' -> BLOCKED('+(e.cause?.code ?? e.name)+')'); }
};
await test('https://api.deepseek.com/models');
await test('https://example.com/');" 2>&1 | tail -3

log "7) 其它入口"
curl -s -o /dev/null -w '  chat-demo: %{http_code}\n' https://aecci.net/
systemctl is-active dsh-web-container dsh-egress-container dsh-gate nginx | sed 's/^/  /'

log "P3 切流完成（回滚脚本已就绪：P2 脚本备份 + gate override 恢复）"
