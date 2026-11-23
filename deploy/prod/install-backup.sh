#!/usr/bin/env bash
# 매일 05:00(KST)에 backup.sh를 돌리는 systemd 타이머를 설치한다. 상용 서버에서 한 번만 실행한다
set -euo pipefail

APP_DIR="$HOME/wordmate"

sudo tee /etc/systemd/system/wordmate-backup.service >/dev/null <<UNIT
[Unit]
Description=WordMate 데이터 백업
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
User=$USER
Environment=HOME=$HOME
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/env bash $APP_DIR/backup.sh
UNIT

# 학적 동기화(04:00)·부정 의심 감지(04:30)가 끝난 뒤. 서버가 꺼져 있었으면 켜진 뒤 바로 돈다(Persistent)
sudo tee /etc/systemd/system/wordmate-backup.timer >/dev/null <<UNIT
[Unit]
Description=WordMate 데이터 백업 (매일)

[Timer]
OnCalendar=*-*-* 05:00:00 Asia/Seoul
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now wordmate-backup.timer
systemctl list-timers wordmate-backup.timer --no-pager
