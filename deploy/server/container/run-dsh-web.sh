#!/usr/bin/env bash
# P3+：DSH Web 容器（内部网络 + 白名单代理 + userns 重映射 + 资源限额）
# 关键点：
#   - 容器在 dsh-int（--internal）网络，无默认路由；出站只能走 dsh-egress（squid 域名白名单）
#   - userns 重映射：容器 root→host subuid(100000)，node(1000)→host 1000，
#     内核级逃逸落点不再是宿主 root
#   - seccomp=unconfined：容器内 bwrap 需要 clone(CLONE_NEWUSER)；
#     外层容器边界 + cap-drop ALL + no-new-privileges 已提供隔离，此处属双层防御
#   - 资源限额：2GB 宿主机上给 DSH 1.3G 内存 / 1.5 CPU / 512 pids
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/dsh/app}
DSH_HOME_DIR=${DSH_HOME_DIR:-/opt/dsh/data}
WORK_DIR=${WORK_DIR:-/opt/dsh/work}
DSH_HOME_PATH=${DSH_HOME_PATH:-/home/node}
NETWORK=${NETWORK:-dsh-int}
STATIC_IP=${STATIC_IP:-10.89.0.50}
IMAGE=${IMAGE:-dsh-web-p2:latest}
DOMAIN=${DOMAIN:-aecci.net}
PUBLIC_PORT=${PUBLIC_PORT:-8443}
EGRESS_CONTAINER=${EGRESS_CONTAINER:-dsh-egress}
MEMORY=${MEMORY:-1300m}
MEMORY_SWAP=${MEMORY_SWAP:-1500m}
CPUS=${CPUS:-1.5}
PIDS=${PIDS:-512}

PROXY_IP=$(podman inspect "$EGRESS_CONTAINER" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null \
  | tr ' ' '\n' | grep -E '^10\.89\.' | head -1)
if [ -z "${PROXY_IP}" ]; then
  echo "egress proxy container '$EGRESS_CONTAINER' is not running on $NETWORK" >&2
  exit 1
fi

install -d -o 1000 -g 1000 -m 700 "$DSH_HOME_DIR" "$WORK_DIR"

exec /usr/bin/podman run --rm --name dsh-web \
  --network "$NETWORK" --ip "$STATIC_IP" \
  --memory "$MEMORY" --memory-swap "$MEMORY_SWAP" --cpus "$CPUS" --pids-limit "$PIDS" \
  --uidmap 0:100000:1000 --uidmap 1000:1000:1 --uidmap 1001:200000:64535 \
  --gidmap 0:100000:1000 --gidmap 1000:1000:1 --gidmap 1001:200000:64535 \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --tmpfs /tmp --tmpfs /run \
  -v "${APP_DIR}:/app:ro" \
  -v "${DSH_HOME_DIR}:/home/node" \
  -v "${WORK_DIR}:${WORK_DIR}" \
  -e HOME=/home/node \
  -e DSH_HOME="${DSH_HOME_PATH}" \
  -e NODE_USE_ENV_PROXY=1 \
  -e HTTPS_PROXY="http://${PROXY_IP}:3128" \
  -e HTTP_PROXY="http://${PROXY_IP}:3128" \
  -e PIP_BREAK_SYSTEM_PACKAGES=1 \
  -e NO_PROXY=localhost,127.0.0.1 \
  -e no_proxy=localhost,127.0.0.1 \
  "$IMAGE" \
  sh -c "IP=\$(hostname -i); IP=\${IP%% *}; exec node --import tsx/esm apps/cli/src/bin.ts web --no-open --host \$IP --port 3080 --public-url https://${DOMAIN}:${PUBLIC_PORT}/ --trusted-host ${DOMAIN}:${PUBLIC_PORT}"
