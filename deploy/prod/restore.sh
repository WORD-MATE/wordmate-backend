#!/usr/bin/env bash
# 백업으로 되돌린다. 지금 DB와 문의 이미지를 지우고 백업 내용으로 바꾸므로 --yes가 있어야 돈다.
# 사용: bash restore.sh backups/mysql/wordmate-YYYYmmdd-HHMMSS.sql.gz [backups/uploads/uploads-....tar.gz] --yes
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/wordmate}"
dump="${1:-}"
uploads=""
confirmed=false
for arg in "${@:2}"; do
  if [ "$arg" = "--yes" ]; then confirmed=true; else uploads="$arg"; fi
done

if [ -z "$dump" ] || [ ! -f "$dump" ]; then
  echo "덤프 파일을 지정하세요: bash restore.sh <wordmate-*.sql.gz> [uploads-*.tar.gz] --yes" >&2
  exit 1
fi
if [ -n "$uploads" ] && [ ! -f "$uploads" ]; then
  echo "이미지 백업 파일이 없습니다: $uploads" >&2
  exit 1
fi
if [ "$confirmed" != true ]; then
  echo "지금 데이터를 지우고 되돌립니다. 확인했으면 --yes를 붙여 다시 실행하세요." >&2
  exit 1
fi

dump="$(realpath "$dump")"
[ -n "$uploads" ] && uploads="$(realpath "$uploads")"
gzip -t "$dump"
cd "$APP_DIR"

# 되돌리는 동안 쓰기가 들어오지 않게 앱을 멈춘다
docker compose stop app
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS wordmate; CREATE DATABASE wordmate CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"'
gunzip -c "$dump" | docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" wordmate'

if [ -n "$uploads" ]; then
  docker run --rm \
    -v "${UPLOADS_VOLUME:-wordmate_uploads}":/dst \
    -v "$(dirname "$uploads")":/src:ro \
    busybox:1.37 sh -c "find /dst -mindepth 1 -delete && tar -xzf /src/$(basename "$uploads") -C /dst"
fi

docker compose up -d --wait app
echo "되돌리기 완료: $dump ${uploads:-(이미지는 그대로)}"
