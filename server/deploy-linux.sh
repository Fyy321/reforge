#!/bin/bash
# 一键部署榜单数据服务到 Linux 服务器（Ubuntu/Debian）。
# 功能：装 Node + Chrome → 每日 04:30 爬八榜 → nginx 静态托管 → 可选 https。
# 用法: sudo bash deploy-linux.sh [域名或IP] [email(可选,用于Let's Encrypt)]
set -euo pipefail

DOMAIN="${1:-localhost}"
EMAIL="${2:-}"

echo "== 1) 系统依赖 =="
apt-get update -qq
apt-get install -y -qq curl wget git nginx unzip ca-certificates fonts-liberation libnss3 libgbm1 xdg-utils >/dev/null

echo "== 2) Node.js 22 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "== 3) Chrome =="
if ! command -v google-chrome >/dev/null 2>&1; then
  wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq ./google-chrome-stable_current_amd64.deb || true
  rm -f google-chrome-stable_current_amd64.deb
fi
CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || true)"
echo "Chrome: $CHROME_BIN"

echo "== 4) 部署 reforge =="
APP_DIR="/opt/reforge"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  (cd "$APP_DIR" && git pull -q)
else
  git clone -q https://github.com/Fyy321/reforge.git "$APP_DIR" || {
    # 仓库取不到时用本地同步（scp 上传后运行）
    echo "git clone 失败，跳过（假设代码已上传到 $APP_DIR）"
  }
fi
OUT_DIR="$APP_DIR/dist/ranks"
mkdir -p "$OUT_DIR"

echo "== 5) 每日定时任务（cron，每天 04:30，失败自动重试 2 次）=="
cat > /etc/cron.d/reforge-ranks <<EOF
SHELL=/bin/bash
BROWSER_PATH=$CHROME_BIN
30 4 * * * root for i in 1 2 3; do (cd $APP_DIR && BROWSER_PATH=$CHROME_BIN node scripts/daily-update.js --out-dir $OUT_DIR >> $APP_DIR/cron.log 2>&1) && break; sleep 60; done
EOF
chmod 644 /etc/cron.d/reforge-ranks

echo "== 6) nginx 静态托管（带缓存头）=="
cat > /etc/nginx/sites-available/reforge <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    root $OUT_DIR;
    index ranks-apple.json;
    location / {
        add_header Cache-Control "max-age=1800, public";
        add_header Access-Control-Allow-Origin "*";
        try_files \$uri =404;
    }
}
EOF
ln -sf /etc/nginx/sites-available/reforge /etc/nginx/sites-enabled/reforge
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== 7) 立即跑第一次（约 6 分钟）=="
(cd "$APP_DIR" && BROWSER_PATH="$CHROME_BIN" node scripts/daily-update.js --out-dir "$OUT_DIR" > "$APP_DIR/first-run.log" 2>&1 && echo "首次抓取成功") || echo "首次抓取失败，看 $APP_DIR/first-run.log"

echo ""
echo "部署完成！数据地址:"
echo "  http://$DOMAIN/ranks-apple.json"
if [ -n "$EMAIL" ]; then
  echo "== 8) 申请 https 证书 =="
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email -n || echo "证书申请失败，可稍后手动: certbot --nginx"
  echo "  https://$DOMAIN/ranks-apple.json"
fi
