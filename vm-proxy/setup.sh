#!/usr/bin/env bash
# 뿌리오 프록시 VM 원클릭 셋업 스크립트 (Oracle Ubuntu 22.04)
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/jaehee05/2027-consulting/main/vm-proxy"
INSTALL_DIR="/home/ubuntu/ppurio-proxy"
SERVICE_FILE="/etc/systemd/system/ppurio-proxy.service"

echo "==> Node.js 20 설치 확인"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node: $(node -v)"

echo "==> 포트 8080 iptables 허용"
if ! sudo iptables -C INPUT -m state --state NEW -p tcp --dport 8080 -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
  sudo netfilter-persistent save
fi

echo "==> server.js 다운로드"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$REPO_RAW/server.js" -o "$INSTALL_DIR/server.js"

echo "==> PROXY_SECRET 생성"
if sudo test -f "$SERVICE_FILE" && sudo grep -q PROXY_SECRET= "$SERVICE_FILE"; then
  PROXY_SECRET=$(sudo grep PROXY_SECRET= "$SERVICE_FILE" | head -1 | sed 's/.*PROXY_SECRET=//')
  echo "    기존 시크릿 유지"
else
  PROXY_SECRET=$(openssl rand -hex 32)
fi

echo "==> systemd 서비스 작성"
sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=Ppurio Proxy
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$INSTALL_DIR
Environment=PROXY_SECRET=$PROXY_SECRET
Environment=PORT=8080
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "==> 서비스 시작"
sudo systemctl daemon-reload
sudo systemctl enable ppurio-proxy >/dev/null 2>&1
sudo systemctl restart ppurio-proxy
sleep 1
sudo systemctl status ppurio-proxy --no-pager | head -10

echo ""
echo "============================================="
echo "  PROXY_SECRET (Cloud Functions 에 넣을 값):"
echo ""
echo "  $PROXY_SECRET"
echo ""
echo "============================================="
