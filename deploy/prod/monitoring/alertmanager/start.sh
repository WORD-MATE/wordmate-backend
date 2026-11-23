#!/bin/sh
# 웹훅 주소가 있을 때만 알림을 보내도록 설정 파일을 만들고 Alertmanager를 띄운다.
# 주소가 없으면 알림은 Grafana(Alerting → 알림 목록)에서만 보인다
set -eu

config=/tmp/alertmanager.yml
receivers=""
if [ -n "${ALERT_DISCORD_WEBHOOK_URL:-}" ]; then
  printf '%s' "$ALERT_DISCORD_WEBHOOK_URL" > /tmp/discord-webhook-url
  receivers="$receivers
    discord_configs:
      - webhook_url_file: /tmp/discord-webhook-url
        send_resolved: true"
fi
if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
  printf '%s' "$ALERT_SLACK_WEBHOOK_URL" > /tmp/slack-webhook-url
  receivers="$receivers
    slack_configs:
      - api_url_file: /tmp/slack-webhook-url
        send_resolved: true"
fi

cat > "$config" <<EOF
route:
  receiver: default
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

inhibit_rules:
  # 앱이 죽으면 오류율·지연 알림은 같은 원인이라 함께 보내지 않는다
  - source_matchers: [alertname="AppDown"]
    target_matchers: [alertname=~"HighErrorRate|HighLatency|QueueUnreachable"]

receivers:
  - name: default$receivers
EOF

exec /bin/alertmanager \
  --config.file="$config" \
  --storage.path=/alertmanager \
  "$@"
