#!/usr/bin/env bash
# 按 uid 限制 DSH 用户出站：只允许 lo（含代理）+ DNS，其余丢弃（必须走白名单代理）
set -euo pipefail
APP_USER=${1:-dsh}
uid=$(id -u "$APP_USER")
command -v firewall-cmd >/dev/null || { echo "firewalld 未安装，跳过" >&2; exit 0; }
systemctl is-active --quiet firewalld || { echo "firewalld 未运行，跳过" >&2; exit 0; }

add4() { firewall-cmd --permanent --direct --add-rule ipv4 filter OUTPUT "$@" >/dev/null 2>&1 || true; }
add6() { firewall-cmd --permanent --direct --add-rule ipv6 filter OUTPUT "$@" >/dev/null 2>&1 || true; }
add4 0 -m owner --uid-owner "$uid" -d 127.0.0.0/8 -j ACCEPT
add4 0 -m owner --uid-owner "$uid" -p udp --dport 53 -j ACCEPT
add4 0 -m owner --uid-owner "$uid" -p tcp --dport 53 -j ACCEPT
add4 10 -m owner --uid-owner "$uid" -j DROP
add6 0 -m owner --uid-owner "$uid" -d ::1/128 -j ACCEPT
add6 0 -m owner --uid-owner "$uid" -p udp --dport 53 -j ACCEPT
add6 0 -m owner --uid-owner "$uid" -p tcp --dport 53 -j ACCEPT
add6 10 -m owner --uid-owner "$uid" -j DROP
firewall-cmd --reload >/dev/null
echo "egress rules applied for uid $uid ($APP_USER)"
