#!/bin/bash
set -e

echo "=== Sake Import Checker 배포 스크립트 ==="

check_secrets() {
    echo "[1/4] Secrets 확인..."
    
    required_secrets=("TELEGRAM_BOT_TOKEN" "GEMINI_API_KEY" "SUPABASE_URL" "SUPABASE_KEY" "ADMIN_PASSWORD")
    
    echo "다음 Secrets가 설정되어 있는지 확인하세요:"
    for secret in "${required_secrets[@]}"; do
        echo "  - $secret"
    done
    
    read -p "모든 Secrets가 설정되었나요? (y/n): " confirm
    if [ "$confirm" != "y" ]; then
        echo "Secrets 설정 방법:"
        echo "  wrangler secret put TELEGRAM_BOT_TOKEN"
        echo "  wrangler secret put GEMINI_API_KEY"
        echo "  wrangler secret put SUPABASE_URL"
        echo "  wrangler secret put SUPABASE_KEY"
        echo "  wrangler secret put ADMIN_PASSWORD"
        exit 1
    fi
}

deploy_worker() {
    echo "[2/4] Cloudflare Worker 배포..."
    cd backend
    npm install
    npm run deploy
    cd ..
}

deploy_admin() {
    echo "[3/4] Admin 페이지 배포..."
    cd admin
    npx wrangler pages deploy . --project-name=sake-admin
    cd ..
}

setup_webhook() {
    echo "[4/4] Telegram Webhook 설정..."
    
    read -p "Telegram Bot Token을 입력하세요: " bot_token
    read -p "Worker URL을 입력하세요 (예: https://sake-import-checker.xxx.workers.dev): " worker_url
    
    curl -X POST "https://api.telegram.org/bot${bot_token}/setWebhook" \
        -d "url=${worker_url}/telegram-webhook"
    
    echo ""
    echo "Webhook 설정 완료!"
}

echo ""
check_secrets
deploy_worker
deploy_admin
setup_webhook

echo ""
echo "=== 배포 완료! ==="
echo "Worker: wrangler tail 로 로그 확인 가능"
echo "Admin: Cloudflare Pages 대시보드에서 URL 확인"
