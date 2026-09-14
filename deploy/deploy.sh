#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 一键部署到 Linux 服务器（在本地项目根目录执行）
#
#   bash deploy/deploy.sh root@1.2.3.4 --domain like.example.com --nginx
#   bash deploy/deploy.sh root@1.2.3.4 --port 8787          # 不配 Nginx
#
# 做三件事：打包代码 -> scp 上传 -> 在服务器上执行 deploy/remote-setup.sh
# 升级时重复执行即可：只替换代码，data/ 与 .env 会保留，并自动备份数据。
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
SSH_PORT="22"
DOMAIN=""
NGINX_FLAG=""
PORT="8787"
APP_DIR="/opt/kimuzhi"

usage() {
  cat <<'EOF'
用法：bash deploy/deploy.sh user@host [选项]

选项：
  --ssh-port <端口>    SSH 端口，默认 22
  --port <端口>        服务监听端口，默认 8787
  --app-dir <目录>     服务器上的安装目录，默认 /opt/kimuzhi
  --domain <域名>      Nginx server_name（可填公网 IP）
  --nginx              强制配置 Nginx 反向代理
  --no-nginx           不配置 Nginx
  -h, --help           显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-port) SSH_PORT="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --app-dir) APP_DIR="${2:?}"; shift 2 ;;
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --nginx) NGINX_FLAG="--nginx"; shift ;;
    --no-nginx) NGINX_FLAG="--no-nginx"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知选项：$1" >&2; usage; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || { usage; exit 2; }
command -v ssh >/dev/null 2>&1 || { echo "本机没有 ssh 命令" >&2; exit 1; }
command -v scp >/dev/null 2>&1 || { echo "本机没有 scp 命令" >&2; exit 1; }

PACKAGE="/tmp/kimuzhi-release-$$.tgz"
SETUP="/tmp/kimuzhi-remote-setup-$$.sh"
REMOTE_PKG="/tmp/kimuzhi-release.tgz"
REMOTE_SETUP="/tmp/kimuzhi-remote-setup.sh"

cleanup() { rm -f "$PACKAGE" "$SETUP"; }
trap cleanup EXIT

echo "==> 打包代码（不含 data/、.git、node_modules）"
tar -czf "$PACKAGE" \
  --exclude='./.git' \
  --exclude='./data' \
  --exclude='./node_modules' \
  --exclude='./backups' \
  --exclude='./.tmp-shots' \
  --exclude='./.env' \
  --exclude='*.log' \
  -C "$ROOT" .
cp "$ROOT/deploy/remote-setup.sh" "$SETUP"

echo "==> 上传到 $TARGET"
scp -P "$SSH_PORT" -q "$PACKAGE" "$TARGET:$REMOTE_PKG"
scp -P "$SSH_PORT" -q "$SETUP" "$TARGET:$REMOTE_SETUP"

echo "==> 在服务器上安装 / 升级"
# shellcheck disable=SC2029
ssh -p "$SSH_PORT" "$TARGET" \
  "sudo bash $REMOTE_SETUP --tarball $REMOTE_PKG --port $PORT --app-dir $APP_DIR ${DOMAIN:+--domain $DOMAIN} $NGINX_FLAG"
