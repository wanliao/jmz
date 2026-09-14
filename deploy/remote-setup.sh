#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 服务器端安装 / 升级脚本（在 Linux 服务器上以 root 运行）
#
# 由 deploy/deploy.sh 或 deploy/deploy.ps1 自动调用，通常不需要手动执行。
# 手动执行示例：
#   sudo bash deploy/remote-setup.sh --tarball /tmp/kimuzhi-release.tgz --domain like.example.com --nginx
#
# 特性：可重复执行（升级只替换代码，保留 data/ 和 .env），升级前自动备份数据。
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="/opt/kimuzhi"
PORT="8787"
SERVICE_NAME="kimuzhi"
DOMAIN=""
WITH_NGINX="auto"
TARBALL=""
NODE_MAJOR_MIN=22

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --nginx) WITH_NGINX="yes"; shift ;;
    --no-nginx) WITH_NGINX="no"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo bash $0 ...）"

# ---------------------------------------------------------------- 1. Node 环境
log "检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
[x] 没有找到 node 命令。本项目用 Node 内置的 SQLite，需要 Node.js 22.5+（推荐 24 LTS）：
      # Debian / Ubuntu
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
      # CentOS / Rocky / AlmaLinux
      curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - && yum install -y nodejs
      # 或者用 Docker：docker compose up -d --build
EOF
  exit 1
fi
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
log "Node.js v$NODE_VERSION"
# 需要内置 SQLite：22.5+ 可用（22.x 需要 --experimental-sqlite），推荐 24 LTS
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "${NODE_MINOR:-0}" -lt 5 ]; }; then
  die "Node.js 版本过低（需要 >= 22.5，推荐 24 LTS），当前 v$NODE_VERSION"
fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  warn "Node.js $NODE_MAJOR.x 的 SQLite 仍需要 --experimental-sqlite 才能用，建议升级到 24 LTS"
fi

# 先决定要不要配 Nginx，因为它决定服务监听 127.0.0.1 还是 0.0.0.0
if [ "$WITH_NGINX" = "auto" ]; then
  command -v nginx >/dev/null 2>&1 && WITH_NGINX="yes" || WITH_NGINX="no"
fi
if [ "$WITH_NGINX" = "yes" ]; then
  DESIRED_HOST="127.0.0.1"   # 由 Nginx 对外反代
else
  DESIRED_HOST="0.0.0.0"     # 直接对外提供访问
fi

# ---------------------------------------------------------------- 2. 目录与用户
log "准备目录 $APP_DIR"
mkdir -p "$APP_DIR" "$APP_DIR/data" "$APP_DIR/backups"

RUN_USER=""
if id kimuzhi >/dev/null 2>&1; then
  RUN_USER="kimuzhi"
elif command -v useradd >/dev/null 2>&1; then
  # 专用系统用户，降低服务被攻破后的影响面
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin kimuzhi >/dev/null 2>&1 && RUN_USER="kimuzhi" || true
fi
[ -n "$RUN_USER" ] && log "服务运行用户：$RUN_USER" || warn "未创建专用用户，服务将以 root 运行"

# ---------------------------------------------------------------- 3. 停服务
# 先停服务再备份数据库，避免复制到写了一半的 SQLite 文件
SERVICE_WAS_ACTIVE="no"
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  SERVICE_WAS_ACTIVE="yes"
  log "暂停 $SERVICE_NAME 以便安全备份数据库"
  systemctl stop "$SERVICE_NAME"
fi

# ---------------------------------------------------------------- 4. 备份数据库
if [ -f "$APP_DIR/data/kimuzhi.db" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  # 有 sqlite3 就先把 WAL 内容并回主文件
  command -v sqlite3 >/dev/null 2>&1 && sqlite3 "$APP_DIR/data/kimuzhi.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  cp -a "$APP_DIR/data/kimuzhi.db" "$APP_DIR/backups/kimuzhi-$STAMP.db"
  log "已备份数据库到 backups/kimuzhi-$STAMP.db"
  # 只保留最近 10 份
  ls -1t "$APP_DIR"/backups/kimuzhi-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# 顺带把旧版 JSON 数据也留一份（如果还在）
if [ -f "$APP_DIR/data/accounts.json" ]; then
  cp -a "$APP_DIR/data/accounts.json" "$APP_DIR/backups/accounts-legacy-$(date +%Y%m%d-%H%M%S).json" 2>/dev/null || true
fi

# ---------------------------------------------------------------- 5. 解压代码
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "找不到上传的包：$TARBALL"
  log "解压代码到 $APP_DIR（会覆盖代码，保留 data/ 与 .env）"
  tar -xzf "$TARBALL" -C "$APP_DIR"
else
  warn "未指定 --tarball，跳过代码解压（假定 $APP_DIR 里已有代码）"
fi

[ -f "$APP_DIR/server/index.js" ] || die "$APP_DIR/server/index.js 不存在，代码解压可能失败了"

# ---------------------------------------------------------------- 6. 写入 .env
if [ ! -f "$APP_DIR/.env" ]; then
  log "生成 $APP_DIR/.env"
  cat > "$APP_DIR/.env" <<EOF
# 由 deploy/remote-setup.sh 生成；改完需要 systemctl restart $SERVICE_NAME
PORT=$PORT
HOST=$DESIRED_HOST
TIME_ZONE=Asia/Shanghai

# SQLite 数据库（用户 / 游戏账号 / 点赞记录）
DB_FILE=./data/kimuzhi.db

# http = 真实接口（配置在 config/endpoints.json）；mock = 假数据演示
ADAPTER=http
# 接口服务的访问密钥（在它的管理界面设置），留空表示不需要
API_KEY=

# 管理员账号（不配则首次启动自动建 admin / admin123，并会在日志里警告）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123

# 自动刷新全部账号的间隔（分钟），0 = 关闭
AUTO_REFRESH_MINUTES=0
# 每周一 00:00:01 结算的宽限窗口
SETTLE_GRACE_MS=600000
EOF
  warn "管理员初始密码是 admin123，请尽快在 ${APP_DIR}/.env 里改掉或到后台「修改我的密码」"
else
  log "$APP_DIR/.env 已存在，保留其余配置（PORT / HOST 会同步成本次部署的值）"
fi

# 保证 PORT / HOST 与本次部署一致，避免出现「服务在 8787、Nginx 反代到别的端口」
set_env_value() {
  local key="$1" value="$2"
  if grep -qE "^[[:space:]]*$key=" "$APP_DIR/.env"; then
    sed -i -E "s|^[[:space:]]*$key=.*|$key=$value|" "$APP_DIR/.env"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}
set_env_value PORT "$PORT"
set_env_value HOST "$DESIRED_HOST"
log "服务监听：$DESIRED_HOST:$PORT$( [ "$WITH_NGINX" = "yes" ] && echo '（由 Nginx 对外反代）' || echo '（直接对外）')"

# ---------------------------------------------------------------- 6. systemd
log "安装 systemd 服务 $SERVICE_NAME.service"
UNIT_SRC="$APP_DIR/deploy/kimuzhi.service"
[ -f "$UNIT_SRC" ] || die "缺少 $UNIT_SRC"

sed -e "s#/opt/kimuzhi#$APP_DIR#g" "$UNIT_SRC" > "/etc/systemd/system/$SERVICE_NAME.service"
if [ -n "$RUN_USER" ]; then
  # 在 [Service] 段后插入 User/Group
  sed -i "/^\[Service\]/a User=$RUN_USER\nGroup=$RUN_USER" "/etc/systemd/system/$SERVICE_NAME.service"
  chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/data" "$APP_DIR/backups" "$APP_DIR/config" 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"
log "服务已启动，等待健康检查…"

OK=""
for _ in $(seq 1 20); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
  else
    sleep 1; OK=1; break
  fi
  sleep 1
done

if [ -n "$OK" ]; then
  log "健康检查通过：http://127.0.0.1:$PORT/api/health"
else
  warn "健康检查未通过，最近日志："
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
  die "服务启动失败"
fi

# ---------------------------------------------------------------- 7. Nginx
if [ "$WITH_NGINX" = "yes" ]; then
  if ! command -v nginx >/dev/null 2>&1; then
    warn "没有安装 Nginx，跳过反向代理配置。可执行：apt-get install -y nginx"
  else
    log "配置 Nginx 反向代理（不会改动你已有的站点配置）"
    SERVER_NAME="${DOMAIN:-_}"
    [ -n "$DOMAIN" ] || warn "没有传 --domain，server_name 用通配 _（可能与你已有站点重叠，建议带域名重跑一次）"

    mkdir -p /etc/nginx/conf.d
    CONF="/etc/nginx/conf.d/kimuzhi.conf"
    [ -f "$CONF" ] && cp -a "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"

    sed -e "s/server_name _;.*/server_name ${SERVER_NAME};/" \
        -e "s#proxy_pass http://127.0.0.1:8787;#proxy_pass http://127.0.0.1:${PORT};#g" \
        "$APP_DIR/deploy/nginx.conf" > "$CONF"

    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx 2>/dev/null || nginx -s reload
      log "Nginx 已重载，配置文件：$CONF"
    else
      warn "nginx -t 检查失败，已生成配置但未生效，请手动排查：nginx -t"
      nginx -t || true
    fi
  fi
fi

# ---------------------------------------------------------------- 8. 收尾
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
echo
log "部署完成 🎉"
echo "    本机地址： http://127.0.0.1:$PORT"
if [ -n "$DOMAIN" ]; then
  echo "    对外地址： http://$DOMAIN"
elif [ -n "$PUBLIC_IP" ]; then
  echo "    对外地址： http://$PUBLIC_IP  （需放行 80 端口 / 安全组）"
fi
echo "    数据文件： $APP_DIR/data/accounts.json"
echo "    配置：     $APP_DIR/.env"
echo "    日志：     journalctl -u $SERVICE_NAME -f"
echo "    重启：     systemctl restart $SERVICE_NAME"
echo "    冒烟测试： node $APP_DIR/scripts/smoke.mjs http://127.0.0.1:$PORT"
echo
