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

ready=false
for _ in $(seq 1 60); do
  if docker exec -e MYSQL_PWD="$password" "$name" mysqladmin ping -h 127.0.0.1 -uroot --silent >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo "임시 MySQL이 2분 안에 뜨지 않았습니다." >&2
  docker logs --tail 30 "$name" >&2
  exit 1
fi

# 비밀번호는 명령마다 MYSQL_PWD로 넘긴다. 컨테이너 전체에 두면 초기화 중 빈 비밀번호 root 접속이 실패한다
gunzip -c "$dump" | docker exec -i -e MYSQL_PWD="$password" "$name" mysql -uroot wordmate
docker exec -e MYSQL_PWD="$password" "$name" mysql -uroot wordmate -N -e \
  "SELECT 'tables', COUNT(*) FROM information_schema.tables WHERE table_schema = 'wordmate'
   UNION ALL SELECT 'users', COUNT(*) FROM users
   UNION ALL SELECT 'study_records', COUNT(*) FROM study_records
   UNION ALL SELECT 'migrations', COUNT(*) FROM __drizzle_migrations;"
echo "확인 완료: $dump"
