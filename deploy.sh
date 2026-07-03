#!/usr/bin/env bash
# Aurora Forecast Now — 统一部署入口
# 用法:
#   sh deploy.sh pages    # 只发静态站（Cloudflare Pages）
#   sh deploy.sh worker   # 只发 API Worker
#   sh deploy.sh all      # 两个都发
#
# 🚨 排除清单是安全边界：workers 源码 / schema.sql / wrangler.worker.toml
#    绝不能进 Pages 静态产物（2026-07-03 曾在公网裸奔，已修复）。
#    以后新增敏感文件，必须同步加进 EXCLUDES。
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-all}"

EXCLUDES=(
  --exclude '.deploy'
  --exclude '.git'
  --exclude 'tools'
  --exclude 'site.config.json'
  --exclude '*.md'
  --exclude 'workers'
  --exclude 'wrangler.worker.toml'
  --exclude 'schema.sql'
  --exclude 'deploy.sh'
  --exclude '技术文章系列'
)

deploy_pages() {
  rm -rf .deploy
  mkdir -p .deploy
  rsync -a "${EXCLUDES[@]}" ./ .deploy/
  npx wrangler pages deploy .deploy --project-name aurora-forecast-now --branch main
}

deploy_worker() {
  npx wrangler deploy --config wrangler.worker.toml
}

case "$TARGET" in
  pages)  deploy_pages ;;
  worker) deploy_worker ;;
  all)    deploy_worker && deploy_pages ;;
  *) echo "用法: sh deploy.sh [pages|worker|all]" >&2; exit 1 ;;
esac
