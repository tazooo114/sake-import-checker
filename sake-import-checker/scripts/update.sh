#!/bin/bash
set -e

echo "=== 서버 업데이트 시작 ==="

cd "$(dirname "$0")/../backend"
echo "[1/2] Worker 배포 중..."
npm run deploy

cd ../admin
echo "[2/2] Admin 페이지 배포 중..."
npx wrangler pages deploy . --project-name=sake-admin --commit-dirty=true

echo ""
echo "=== 업데이트 완료! ==="
