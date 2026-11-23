#!/usr/bin/env bash
# 복구 리허설: 백업 덤프를 임시 MySQL 컨테이너에 넣어 실제로 읽히는지 확인한다. 운영 DB는 건드리지 않는다.
# 사용: bash verify-backup.sh [backups/mysql/wordmate-....sql.gz]  (생략하면 가장 최근 백업)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/wordmate}"
dump="${1:-$(ls -1t "$APP_DIR"/backups/mysql/wordmate-*.sql.gz | head -1)}"
dump="$(realpath "$dump")"
name="wordmate-restore-check-$$"
password="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --memory 1g --tmpfs /var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD="$password" -e MYSQL_DATABASE=wordmate \
  mysql:8.4 --innodb-buffer-pool-size=256M --performance-schema=OFF >/dev/null

for _ in $(seq 1 60); do
  docker exec "$name" mysqladmin ping -h 127.0.0.1 -uroot -p"$password" --silent 2>/dev/null && break
  sleep 2
done

gunzip -c "$dump" | docker exec -i "$name" mysql -uroot -p"$password" wordmate 2>/dev/null
docker exec "$name" mysql -uroot -p"$password" wordmate -N -e \
  "SELECT 'tables', COUNT(*) FROM information_schema.tables WHERE table_schema = 'wordmate'
   UNION ALL SELECT 'users', COUNT(*) FROM users
   UNION ALL SELECT 'study_records', COUNT(*) FROM study_records
   UNION ALL SELECT 'migrations', COUNT(*) FROM __drizzle_migrations;" 2>/dev/null
echo "확인 완료: $dump"
