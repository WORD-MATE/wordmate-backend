# 운영·배포

## 점검 모드·강제 업데이트

Valkey의 `app:config` 키(JSON)로 설정하며 서버는 5초마다 다시 읽습니다. 관리자 API가 생기기 전까지는 직접 설정합니다.

```bash
valkey-cli SET app:config '{"maintenance":{"enabled":true,"message":"정기 점검","endsAt":"2026-12-01T00:00:00.000Z"},"minVersion":{"IOS":"1.2.0"},"latestVersion":{"IOS":"1.5.0"},"storeUrl":{"IOS":"https://apps.apple.com/..."}}'
```

- 점검 중: 503 `MAINTENANCE` (`detail`: `message`, `endsAt`)
- 최소 버전 미만: 426 `UPDATE_REQUIRED` (`detail.storeUrl`, 웹은 `null`)
- `GET /app/status`는 점검 중에도 200으로 점검 정보와 업데이트 상태(`REQUIRED` / `RECOMMENDED` / `NONE`)를 돌려줍니다.

## 상태 확인·지표

상태 확인은 인증·클라이언트 헤더가 필요 없고 점검 중·강제 업데이트 중에도 응답합니다. 10초마다 오는 요청이라 접속 로그와 요청 지표에서는 뺍니다(오류는 로그에 남음).

| 엔드포인트          | 확인 내용                    | 실패                                                       | 용도                           |
| ------------------- | ---------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `GET /health`       | DB·Valkey 연결 (각 2초 제한) | 503 `HEALTH_CHECK_FAILED`                                  | 컨테이너 healthcheck·배포 확인 |
| `GET /health/live`  | 프로세스가 응답하는지만      | 없음                                                       | 의존 서비스와 무관한 생존 확인 |
| `GET /health/ready` | DB·Valkey 연결과 응답 시간   | 503 `HEALTH_CHECK_FAILED`, 종료 중이면 503 `SHUTTING_DOWN` | 요청을 받을 준비가 됐는지      |

`/health`는 기존 응답(`{"status":"ok","checks":{"db":"up","valkey":"up"}}`)을 그대로 유지합니다. compose의 `restart: unless-stopped`는 unhealthy만으로 컨테이너를 다시 시작하지 않으므로 Valkey가 잠깐 느려도 재시작되지 않습니다.

### 지표 (Prometheus)

`GET /metrics`는 API 포트(3000)가 아니라 내부 포트 `METRICS_PORT`(기본 `9464`)에서만 응답합니다. compose에서 이 포트를 서버에 열지 않으므로 학교 프록시를 거친 외부 요청은 닿지 않고, 같은 도커 네트워크(`wordmate_internal`)의 Prometheus만 `app:9464/metrics`로 수집합니다. `METRICS_PORT=0`이면 끕니다.

| 지표                            | 라벨                        | 설명                                                |
| ------------------------------- | --------------------------- | --------------------------------------------------- |
| `http_requests_total`           | `method`, `route`, `status` | 요청 수. 오류율은 `status`로 계산                   |
| `http_request_duration_seconds` | `method`, `route`, `status` | 처리 시간 히스토그램 (10ms~10s)                     |
| `wordmate_realtime_connections` | 없음                        | 이 인스턴스에 인증을 마친 WebSocket 연결 수         |
| `wordmate_queue_jobs`           | `queue`, `state`            | 큐별 `waiting` / `active` / `delayed` / `failed` 수 |
| `wordmate_queue_up`             | `queue`                     | 큐 작업 수를 1초 안에 읽었으면 1, 아니면 0          |
| `process_*`, `nodejs_*`         | 없음                        | 메모리·CPU·이벤트 루프 지연·GC 등 기본 지표         |

- `route`는 실제 주소가 아니라 라우트 패턴(`/packs/:packId`)이라 라벨 수가 늘지 않습니다. 맞는 라우트가 없는 요청은 `UNMATCHED` 하나로 묶습니다.
- 큐 작업 수는 수집할 때 Valkey에서 읽습니다. Valkey가 느리면 그 큐만 `wordmate_queue_up 0`이 되고 나머지 지표는 그대로 나옵니다.

## Docker

```bash
docker build -t wordmate-backend .
docker run -p 3000:3000 -e DATABASE_URL=... -e VALKEY_URL=... wordmate-backend
```

## 배포 (개발 서버)

`develop`에 머지되면 GitHub Actions(`deploy-dev.yml`)가 이미지를 GHCR(`ghcr.io/word-mate/wordmate-backend`)에 올리고, 서버에 SSH로 접속해 `deploy/dev/compose.yml`로 교체합니다.

- 구성: 학교 플랫폼 도메인(`{DEV_DOMAIN}`, HTTPS 처리) → 서버 3000 포트(앱) ← MySQL 8.4 · Valkey 9, 모두 컨테이너
- 앱이 뜨기 전에 `migrate` 컨테이너가 마이그레이션을 실행합니다.
- 서버 파일: `~/wordmate/` (`compose.yml`은 배포 때마다 덮어씀, `.env`만 서버에서 관리)

### 서버 최초 설정

1. 학교 서버 관리 페이지에서 도메인을 추가합니다 (서브도메인 `{서브도메인}`, 내부 포트 `3000`).
2. 서버에서 `deploy/setup-server.sh`를 실행합니다 (Docker 설치, swap 2GB, `~/wordmate` 생성). 끝나면 다시 로그인합니다.
3. `~/wordmate/.env`를 만듭니다.

```bash
MYSQL_PASSWORD=          # openssl rand -hex 24
MYSQL_ROOT_PASSWORD=     # openssl rand -hex 24
JWT_PRIVATE_KEY=         # openssl genpkey -algorithm ed25519 | awk '{printf "%s\\n", $0}'
DATAGSM_CLIENT_ID=
DATAGSM_REDIRECT_URIS=
CORS_ORIGINS=
SWAGGER_ENABLED=true
DATAGSM_API_KEY=         # 학적 동기화 (없으면 건너뜀)
# TRUST_PROXY={프록시 주소} # 학교 프록시 주소가 다르면 지정
```

4. 배포용 SSH 키를 만들어 공개키를 서버의 `~/.ssh/authorized_keys`에 추가합니다.
5. GitHub 저장소 Settings에 등록합니다. 시크릿은 Environments → `development`, 변수는 Secrets and variables → Actions → Variables(저장소 변수)에 넣습니다. `DEV_DOMAIN`이 없으면 배포 단계를 건너뜁니다.

| 종류     | 이름                  | 값                                       |
| -------- | --------------------- | ---------------------------------------- |
| Secret   | `DEV_SSH_HOST`        | 서버 주소                                |
| Secret   | `DEV_SSH_USER`        | `ubuntu`                                 |
| Secret   | `DEV_SSH_PORT`        | SSH 포트 (22면 생략)                     |
| Secret   | `DEV_SSH_KEY`         | 배포용 개인키                            |
| Secret   | `DEV_SSH_KNOWN_HOSTS` | `ssh-keyscan -p {포트} {서버 주소}` 결과 |
| Variable | `DEV_DOMAIN`          | 개발 서버 도메인                         |

### 운영 명령

```bash
cd ~/wordmate
docker compose ps
docker compose logs -f app
docker compose exec valkey valkey-cli         # 점검 모드 설정 등
docker compose exec mysql mysql -uroot -p wordmate
docker compose up -d --force-recreate app     # .env 수정 후 적용
```

배포 때 받은 이미지에 `develop` 태그도 붙여 두므로, 서버에서 직접 `docker compose`를 실행해도 마지막 배포 이미지를 씁니다 (GHCR 로그인 불필요).

### 개발 서버 이전

새 서버로 옮길 때는 최초 설정 1~4를 새 서버에서 다시 하고, GitHub의 `DEV_SSH_*` 시크릿과 `DEV_DOMAIN`을 새 서버 값으로 바꿉니다. 바꾸기 전까지는 develop 머지가 옛 서버로 배포됩니다.

개발 데이터를 옮기려면 옛 서버에서 덤프해 새 서버에서 넣습니다. 새 서버에서는 앱을 띄우기 전에 MySQL만 먼저 올립니다.

```bash
# 옛 서버
cd ~/wordmate && docker compose exec -T mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines wordmate' | gzip > wordmate.sql.gz
# 새 서버 (wordmate.sql.gz를 복사한 뒤)
cd ~/wordmate && docker compose up -d mysql
gunzip -c wordmate.sql.gz | docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" wordmate'
```

`JWT_PRIVATE_KEY`를 새로 만들면 기존 로그인은 모두 풀리고 문의 이미지 서명 주소도 바뀝니다. 그대로 쓰려면 옛 서버의 값을 옮깁니다.

## 배포 (상용 서버)

`deploy/prod/compose.yml`로 개발 서버와 같은 구성(앱·마이그레이션·MySQL·Valkey)을 띄웁니다. 기본 이미지 태그는 `main`입니다.

- 서버 사양: 2 Core / 8 GB / 40 GB. 메모리 제한은 앱 1.5 GB, MySQL 2.5 GB(buffer pool 1.5 GB), Valkey 640 MB이고, 나머지는 모니터링과 OS 몫입니다.
- 앱 포트(3000)만 서버에 열고 MySQL·Valkey는 컨테이너 네트워크 안에서만 씁니다.
- 부하 테스트 계정 스크립트는 상용에서 막혀 있습니다(`LOAD_TEST_ALLOWED` 없음).
- 데이터는 named volume `mysql-data`, `valkey-data`, `uploads`(문의 이미지)에 있습니다.

### 상용 서버 최초 설정

1. 학교 서버 관리 페이지에서 도메인을 추가합니다 (내부 포트 `3000`).
2. 저장소의 `deploy/setup-server.sh`를 서버로 복사해 `SWAP_SIZE=4G bash setup-server.sh`로 실행하고 다시 로그인합니다.
3. `~/wordmate/.env`를 만듭니다. 항목은 개발 서버와 같고, 비밀번호·JWT 키는 개발 서버와 다른 값으로 새로 만듭니다. `SWAGGER_ENABLED`는 넣지 않습니다(상용에서는 API 문서를 열지 않음). `CORS_ORIGINS`·`DATAGSM_REDIRECT_URIS`는 상용 웹 주소로 넣습니다.
4. 배포용 SSH 키를 개발 서버와 따로 만들어 공개키를 `~/.ssh/authorized_keys`에 추가합니다.
5. GitHub에 아래 시크릿·변수를 등록합니다. 시크릿은 Environments → `production`, 변수는 저장소 변수에 넣습니다. `PROD_DOMAIN`이 없으면 배포 단계를 건너뜁니다. `production` 환경에 Required reviewers를 켜 두면 배포 전에 승인을 받습니다.

| 종류     | 이름                   | 값                                       |
| -------- | ---------------------- | ---------------------------------------- |
| Secret   | `PROD_SSH_HOST`        | 서버 주소                                |
| Secret   | `PROD_SSH_USER`        | `ubuntu`                                 |
| Secret   | `PROD_SSH_PORT`        | SSH 포트 (22면 생략)                     |
| Secret   | `PROD_SSH_KEY`         | 배포용 개인키                            |
| Secret   | `PROD_SSH_KNOWN_HOSTS` | `ssh-keyscan -p {포트} {서버 주소}` 결과 |
| Variable | `PROD_DOMAIN`          | 상용 서버 도메인                         |

6. develop을 main에 머지하면 첫 배포가 됩니다. `main` 이미지는 이 워크플로가 처음 돌 때 만들어지므로, 그 전에 서버에서 직접 `docker compose up`을 하면 이미지를 받지 못합니다.
7. 첫 배포 뒤 관리자가 될 사람이 한 번 로그인하면, DB에서 그 계정을 찾아 최초 관리자로 지정합니다. 이메일이 비어 있는 계정도 있어서 ID로 지정하고, 바뀐 행이 1개인지 확인합니다. 지정한 사람은 다시 로그인해야 관리자 권한이 토큰에 들어갑니다.

```bash
docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" wordmate'
# mysql> SELECT BIN_TO_UUID(id), name, email, student_number, role FROM users WHERE name = '이름';
# mysql> UPDATE users SET is_admin = 1 WHERE id = UUID_TO_BIN('위에서 찾은 ID');   -- Rows matched: 1 확인
```

운영 명령은 개발 서버와 같습니다(`docker compose`는 `~/wordmate`에서 실행).

### 상용 배포·되돌리기

`main`에 push되면 `deploy-prod.yml`이 이미지를 `main`·`sha-{커밋 12자}` 태그로 GHCR에 올리고, 서버에서 마이그레이션 뒤 앱을 교체합니다. 끝나면 `https://{PROD_DOMAIN}/health`로 확인하고, 실패하면 컨테이너 상태와 로그를 남기고 실패로 끝납니다.

- 배포한 이미지는 서버에서 `main` 태그로도 붙여 두므로 서버에서 직접 `docker compose`를 실행해도 마지막 배포 이미지를 씁니다.
- 되돌리기용으로 서버에 직전 `sha-*` 이미지 2개를 남깁니다.
- 되돌리기: Actions → Deploy (prod) → Run workflow에서 브랜치를 `main`으로 고르고(기본값이 develop이라 바꿔야 함, main이 아니면 아무것도 하지 않음) `tag`에 이전 태그(예: `sha-0123456789ab`)를 넣으면 빌드 없이 그 이미지로 바꿉니다. 태그는 GHCR 패키지 목록이나 이전 배포 로그에서 찾습니다.
- 마이그레이션은 되돌리지 않습니다. 스키마를 바꾼 배포를 되돌리면 예전 코드가 새 스키마에서 돌게 되므로, 컬럼 삭제·이름 변경 같은 마이그레이션은 코드 배포와 나눠서 올립니다.

### 상용 백업·복구

`deploy/prod/`의 스크립트를 배포 워크플로가 서버 `~/wordmate/`에 복사합니다. 백업은 `~/wordmate/backups/`에 쌓입니다.

- 매일 05:00(KST): `backup.sh`가 MySQL 덤프(`mysql/wordmate-{시각}.sql.gz`)와 문의 이미지(`uploads/uploads-{시각}.tar.gz`)를 만들고, 14일(`BACKUP_KEEP_DAYS`) 지난 백업을 지웁니다. 학적 동기화·부정 의심 감지가 끝난 뒤입니다.
- 상용 배포 때 마이그레이션 전에 한 번 더 백업합니다(MySQL이 아직 없는 첫 배포는 건너뜀).
- 덤프는 `--single-transaction`이라 서비스를 멈추지 않습니다. 받는 중 실패하면 `.part` 파일만 남고 1시간 뒤 지워집니다.
- 성공하면 `~/wordmate/metrics/backup.prom`에 마지막 성공 시각을 남깁니다(백업 폴더는 소유자만 읽고, 이 파일만 따로 둠). 모니터링이 이 값을 보고 백업이 멈추면 알립니다.
- 백업이 서버 디스크에만 있으므로 서버를 잃으면 백업도 잃습니다. 주기적으로 다른 곳(개발 서버, 개인 PC 등)에 복사해 둡니다.

처음 한 번 타이머를 설치합니다(첫 배포 뒤 스크립트가 서버에 복사된 다음).

```bash
cd ~/wordmate
bash install-backup.sh                       # systemd 타이머 등록
sudo systemctl start wordmate-backup         # 바로 한 번 실행
journalctl -u wordmate-backup -n 50          # 결과 확인
ls -lh backups/mysql backups/uploads
```

복구 리허설(운영 DB는 건드리지 않음): 임시 MySQL 컨테이너에 덤프를 넣어 테이블·사용자 수를 출력합니다. 한 달에 한 번 정도 돌려 백업이 실제로 읽히는지 확인합니다.

```bash
bash verify-backup.sh                        # 가장 최근 백업
bash verify-backup.sh backups/mysql/wordmate-20261201-050000.sql.gz
```

실제 복구: 앱을 멈추고 DB(와 문의 이미지)를 백업 내용으로 바꾼 뒤 앱을 다시 띄웁니다. 지금 데이터가 지워지므로 `--yes`가 있어야 돕니다. 복구 전 상태도 남기려면 먼저 `bash backup.sh`를 한 번 돌립니다.

```bash
bash restore.sh backups/mysql/wordmate-20261201-050000.sql.gz backups/uploads/uploads-20261201-050000.tar.gz --yes
```

덤프가 앱 버전보다 예전 스키마여도 앱이 뜰 때 `migrate`가 마이그레이션을 다시 적용합니다. 반대로 덤프가 지금 앱보다 새 스키마면 그 시점의 이미지로 되돌린 뒤 복구합니다.

### 상용 모니터링

`deploy/prod/monitoring/`의 구성을 앱과 다른 compose 프로젝트(`wordmate-monitoring`)로 띄웁니다. 배포의 `--remove-orphans`가 지우지 않도록 나눴고, Prometheus만 앱 네트워크(`wordmate_internal`)에 붙어 `app:9464/metrics`를 수집합니다. 배포 워크플로는 설정 파일을 `~/wordmate/monitoring/`에 복사만 하고 다시 띄우지는 않습니다.

| 구성 요소     | 역할                                                         | 메모리 제한 |
| ------------- | ------------------------------------------------------------ | ----------- |
| Prometheus    | 앱·서버 지표 수집(15초), 알림 규칙 계산                      | 512 MB      |
| Alertmanager  | 알림 묶기·전송 (웹훅이 있을 때만)                            | 64 MB       |
| node-exporter | 서버 CPU·메모리·디스크, 백업 지표 파일(`~/wordmate/metrics`) | 64 MB       |
| Loki          | 로그 저장                                                    | 384 MB      |
| Alloy         | 도커 소켓(읽기 전용)으로 컨테이너를 찾아 로그를 Loki로 보냄  | 256 MB      |
| Grafana       | 대시보드·로그 조회·알림 목록. 3001 포트, 서브도메인으로 접속 | 256 MB      |

- 모두 합쳐 약 1.5 GB입니다. 앱 쪽(약 4.7 GB)과 더하면 6.2 GB이고 나머지가 OS·페이지 캐시 몫입니다.
- 보관: 지표 15일 또는 2 GB 중 먼저 닿는 쪽, 로그 14일(Loki compactor가 지움). 모니터링 컨테이너 자체 로그는 컨테이너마다 10 MB × 3개까지만 남깁니다.
- 로그에는 `container`, `project`, `service` 라벨이 붙습니다. 앱(`service="app"`, `migrate`) 로그는 pino JSON의 숫자 수준을 `level` 라벨(`info`, `warn`, `error` 등)로 바꿉니다. 예: `{project="wordmate", service="app", level="error"}`
- 설정 검사: `deploy/prod/monitoring/`을 바꾸는 PR에서 `monitoring-check.yml`이 compose·Prometheus 설정·알림 규칙 테스트(`prometheus/tests/`)·Loki·Alloy 설정을 검사하고, 전체를 띄워 수집·로그 전달·Grafana 프로비저닝까지 확인합니다.

처음 한 번 서버에서 띄웁니다(앱 첫 배포 뒤, 앱 네트워크와 설정 파일이 생긴 다음). 백업 지표 폴더는 node-exporter가 읽으므로 먼저 있어야 합니다(없으면 시작이 실패함, 백업 타이머를 설치했다면 이미 있음).

```bash
mkdir -p ~/wordmate/metrics
cd ~/wordmate/monitoring
cat > .env <<'EOF'
GF_SECURITY_ADMIN_PASSWORD=     # openssl rand -hex 16
# ALERT_DISCORD_WEBHOOK_URL=    # 알림을 받을 때만 (아래 참고)
# ALERT_SLACK_WEBHOOK_URL=
EOF
chmod 600 .env
docker compose up -d
docker compose ps
```

- `.env`는 서버의 `~/wordmate/monitoring/.env`에만 둡니다(배포가 덮어쓰지 않음). `GF_SECURITY_ADMIN_PASSWORD`가 없으면 시작하지 않습니다.
- Grafana 비밀번호는 처음 뜰 때만 적용됩니다. 나중에 바꾸려면 `docker compose exec grafana grafana cli admin reset-admin-password '새 비밀번호'`를 실행합니다.
- 배포로 설정 파일이 바뀐 뒤 적용: `cd ~/wordmate/monitoring && docker compose up -d --force-recreate`
- 앱 compose를 `docker compose down`으로 내릴 때는 Prometheus가 앱 네트워크에 붙어 있어 네트워크를 지우지 못합니다. 모니터링을 먼저 내리거나(`docker compose down`), 앱은 `stop`으로 멈춥니다.

Grafana 접속: 학교 서버 관리 페이지에서 서브도메인을 하나 더 만들어 내부 포트 `3001`로 연결하고, `.env`에 아래를 넣은 뒤 `docker compose up -d --force-recreate grafana`로 적용합니다. 로그인하면 WordMate 대시보드(요청 수·지연·5xx(라우트별), 실시간 연결, 큐 작업, CPU·메모리·디스크, 마지막 백업 후 경과 시간, 앱 로그)가 홈으로 열립니다.

```bash
GRAFANA_ROOT_URL=https://{Grafana 서브도메인}
GRAFANA_COOKIE_SECURE=true        # HTTPS 전용 쿠키·HSTS
# GF_SECURITY_ADMIN_USER=admin    # 처음 뜰 때만 적용
```

- 로그인 화면이 인터넷에 열리므로 비밀번호는 길게(`openssl rand -hex 16` 이상) 둡니다. 회원가입·익명 접근은 꺼져 있고, 로그인 실패가 반복되면 Grafana가 잠시 막습니다.
- `GRAFANA_COOKIE_SECURE=true`이면 `http://`로는 로그인할 수 없습니다. 서브도메인 없이 SSH 터널(`ssh -N -L 3001:127.0.0.1:3001 ...` → `http://localhost:3001`)로 들어갈 때는 이 값을 빼야 합니다.

알림 규칙(`prometheus/rules/wordmate.yml`):

| 알림                     | 조건                                                         | 수준     |
| ------------------------ | ------------------------------------------------------------ | -------- |
| `AppDown`                | 앱 지표 수집 실패 2분                                        | critical |
| `HighErrorRate`          | 5분 동안 5xx 비율 5% 초과 (초당 0.2건 이상일 때), 5분 지속   | critical |
| `HighLatency`            | 5분 동안 응답 p95 1초 초과 (초당 0.2건 이상일 때), 10분 지속 | warning  |
| `QueueUnreachable`       | `wordmate_queue_up == 0` 5분                                 | warning  |
| `QueueFailedJobsGrowing` | 큐의 실패 작업이 1시간에 3개 이상 늘어남                     | warning  |
| `DiskSpaceLow`           | 디스크 남은 공간 15% 미만 10분                               | critical |
| `MemoryPressure`         | 사용 가능한 메모리 10% 미만 10분                             | warning  |
| `OomKill`                | 메모리 부족으로 프로세스가 강제 종료됨(mem_limit 도달 등)    | warning  |
| `BackupStale`            | 마지막 백업 성공 후 26시간 초과, 또는 백업 지표 없음 30분    | critical |
| `MonitoringTargetDown`   | 앱 외 수집 대상(node-exporter·Loki 등) 실패 5분              | warning  |
| `TextfileMetricError`    | 백업 지표 파일을 읽지 못함 10분                              | warning  |

- 앱이 죽어 있는 동안은 오류율·지연·큐 알림을 함께 보내지 않습니다(같은 원인).
- 백업 타이머를 설치하기 전에는 `BackupStale`이 계속 울립니다. 상용 백업·복구의 타이머 설치를 먼저 합니다.

알림 받기: 웹훅이 없으면 알림은 Grafana의 Alerting → Alert rules(데이터 소스 Prometheus)와 Alertmanager 데이터 소스에서만 보이고 아무 곳에도 보내지 않습니다. 받으려면 `.env`에 웹훅 주소를 넣고 Alertmanager를 다시 띄웁니다. 둘 다 넣으면 양쪽으로 보냅니다.

- Discord: 채널 설정 → 연동 → 웹후크 → 새 웹후크 → URL 복사 → `ALERT_DISCORD_WEBHOOK_URL`
- Slack: Incoming Webhooks 앱으로 만든 URL → `ALERT_SLACK_WEBHOOK_URL`
- 적용: `cd ~/wordmate/monitoring && docker compose up -d alertmanager` (주소가 바뀌면 컨테이너가 새로 만들어짐)
- 같은 알림은 4시간마다 다시 보내고, 해결되면 해결 알림을 보냅니다.

## 정리 작업

BullMQ `maintenance` 큐의 job scheduler로 돌립니다(`src/modules/maintenance`). 스케줄은 Valkey에 저장돼서 인스턴스가 여러 개여도 한 번만 실행되고, 앱을 다시 띄워도 upsert라 중복 등록되지 않습니다.

| 작업                    | 주기 (KST) | 내용                                                                                                                                                                         |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expire-study-sessions` | 매시 5분   | 만료된 `IN_PROGRESS` 학습을 `ABANDONED`로 바꿈                                                                                                                               |
| `daily-cleanup`         | 매일 03:00 | 위 작업에 더해, 끝났거나 버린 지 7일 지난 세션(문항·답안 포함) 삭제, 7일 지난 연습 삭제, 30일 지난 알림 삭제, 삭제된 단어의 즐겨찾기 삭제, 정지 기간이 끝난 탈퇴자 정보 삭제 |

- 학습 기록(`study_records`)은 지우지 않습니다. 사용자가 늘면 보관 기간을 다시 정합니다. 세션을 지워도 기록은 남고 `study_records.session_id`만 NULL이 됩니다.
- 지울 행은 1000개씩 나눠 지워서 테이블을 오래 잠그지 않습니다.
- `daily-cleanup`은 DB에 없는 문의 이미지 파일(파일을 쓴 뒤 DB에 저장하기 전에 서버가 멈춘 경우)도 저장한 지 하루가 지나면 지웁니다. 파일 이름이 이미지 ID 형식이 아니면 건드리지 않습니다.
- 스케줄 등록은 앱 시작을 기다리게 하지 않습니다. Valkey가 내려가 있으면 BullMQ 명령은 연결될 때까지 대기하므로, 기다리면 앱 시작이 멈춥니다.
