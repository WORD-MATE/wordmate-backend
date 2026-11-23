#!/usr/bin/env bash
# 상용 데이터 백업: MySQL 덤프와 문의 이미지(uploads 볼륨)를 압축해 보관하고, 오래된 백업을 지운다.
# systemd 타이머(install-backup.sh)가 매일 돌리고, 상용 배포 직전에도 한 번 돌린다.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/wordmate}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S)"
# 백업 폴더는 소유자만 읽게 두고, 모니터링이 읽을 지표 파일은 따로 둔다
METRICS_DIR="${METRICS_DIR:-$APP_DIR/metrics}"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR/mysql" "$BACKUP_DIR/uploads" "$METRICS_DIR"
chmod 700 "$BACKUP_DIR"
chmod 755 "$METRICS_DIR"

write_metric() {
  # 모니터링(node-exporter textfile)이 마지막 성공 시각을 보고 백업이 멈췄는지 알린다
  local tmp="$METRICS_DIR/backup.prom.$$"
  {
    echo "# HELP wordmate_backup_last_success_timestamp_seconds 마지막으로 성공한 백업 시각"
    echo "# TYPE wordmate_backup_last_success_timestamp_seconds gauge"
    echo "wordmate_backup_last_success_timestamp_seconds $(date +%s)"
    echo "# HELP wordmate_backup_size_bytes 마지막 백업 크기"
    echo "# TYPE wordmate_backup_size_bytes gauge"
    echo "wordmate_backup_size_bytes{kind=\"mysql\"} $1"
    echo "wordmate_backup_size_bytes{kind=\"uploads\"} $2"
  } > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$METRICS_DIR/backup.prom"
}

dump="$BACKUP_DIR/mysql/wordmate-$STAMP.sql.gz"
# 받는 도중 실패하면 반쪽 파일이 남지 않게 임시 이름으로 받고 검사한 뒤 옮긴다
docker compose exec -T mysql sh -c \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF wordmate' \
  | gzip > "$dump.part"
gzip -t "$dump.part"
mv "$dump.part" "$dump"

uploads="$BACKUP_DIR/uploads/uploads-$STAMP.tar.gz"
docker run --rm --user "$(id -u):$(id -g)" \
  -v "${UPLOADS_VOLUME:-wordmate_uploads}":/src:ro \
  -v "$BACKUP_DIR/uploads":/dst \
  busybox:1.37 tar -czf "/dst/uploads-$STAMP.tar.gz.part" -C /src .
mv "$uploads.part" "$uploads"

find "$BACKUP_DIR/mysql" -name 'wordmate-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR/uploads" -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name '*.part' -mmin +60 -delete

write_metric "$(stat -c %s "$dump")" "$(stat -c %s "$uploads")"
echo "백업 완료: $dump, $uploads"
