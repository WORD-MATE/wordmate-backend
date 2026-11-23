#!/usr/bin/env bash
# 학교 서버(Ubuntu) 최초 설정. 개발·상용 서버 모두 같은 스크립트를 쓴다
# 사용: bash setup-server.sh            (swap 2G)
#       SWAP_SIZE=4G bash setup-server.sh
set -euo pipefail

SWAP_SIZE="${SWAP_SIZE:-2G}"

if ! command -v docker >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

# MySQL 피크나 메모리 제한 근처에서 OOM으로 컨테이너가 죽지 않게 swap을 둔다
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l "$SWAP_SIZE" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

mkdir -p "$HOME/wordmate"
chmod 700 "$HOME/wordmate"
echo "완료. docker 그룹 적용을 위해 다시 로그인하세요."
