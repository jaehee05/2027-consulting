#!/usr/bin/env bash
# 루트의 웹앱 정적 파일을 mobile/www/ 로 복사하는 빌드 스크립트.
# Capacitor 의 webDir 가 www 이므로, npx cap sync/copy 전에 반드시 실행.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WWW_DIR="$SCRIPT_DIR/www"

echo "[build] root=$ROOT_DIR"
echo "[build] www=$WWW_DIR"

rm -rf "$WWW_DIR"
mkdir -p "$WWW_DIR"

# 필수 자산
cp "$ROOT_DIR/index.html" "$WWW_DIR/index.html"
cp "$ROOT_DIR/favicon.png" "$WWW_DIR/favicon.png"

# 선택 자산 (있을 때만 복사)
for f in manifest.webmanifest sw.js apple-touch-icon.png robots.txt; do
  if [ -f "$ROOT_DIR/$f" ]; then
    cp "$ROOT_DIR/$f" "$WWW_DIR/$f"
    echo "[build] copied $f"
  fi
done

echo "[build] done. $(ls -1 "$WWW_DIR" | wc -l) files in www/"
