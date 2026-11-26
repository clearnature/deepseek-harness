#!/usr/bin/env bash
# P3：出站白名单代理容器（squid），双网卡：dsh-int（供 DSH 访问）+ 默认网络（出网）
set -euo pipefail
EGRESS_IMAGE=${EGRESS_IMAGE:-dsh-egress:latest}
INTERNAL_NET=${INTERNAL_NET:-dsh-int}
OUTBOUND_NET=${OUTBOUND_NET:-podman}

DNS_ARGS=()
while read -r ns; do
  [ -n "$ns" ] && DNS_ARGS+=(--dns "$ns")
done < <(awk '/^nameserver/{print $2}' /etc/resolv.conf | head -2)

/usr/bin/podman rm -f dsh-egress >/dev/null 2>&1 || true
exec /usr/bin/podman run --rm --name dsh-egress \
  --network "$INTERNAL_NET" --network "$OUTBOUND_NET" \
  "${DNS_ARGS[@]}" \
  --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID \
  --pids-limit=128 \
  "$EGRESS_IMAGE"
