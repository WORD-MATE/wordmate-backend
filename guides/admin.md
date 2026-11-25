# 관리자

## 관리자

- 관리자 API는 `/admin` 아래이고 `@Auth('ADMIN')`(관리자 권한이 있는 사용자)만 씁니다. 관리자 기능은 `src/modules/admin/`에 모읍니다.
- 관리자 행동은 바꾸는 작업과 같은 트랜잭션에서 `AuditLogService.record`로 감사 로그에 남깁니다(행위자·행동·대상·상세·IP·User-Agent). 교사 담당 반 변경도 남깁니다.
- `GET /admin/audit-logs`: 행위자·대상·행동·기간(KST 날짜, 양 끝 포함)으로 걸러 최신순 페이지로 봅니다.

### 사용자 관리

- `GET /admin/users`(학번 앞부분·이름 포함 검색, 역할·관리자·상태 필터)와 `GET /admin/users/{userId}`(학습·대결 요약, 받은 신고 수, 담당 반). 개인정보 열람이라 조회도 감사 로그에 남깁니다.
- 관리자 권한은 학생·교사 모두에게 줄 수 있습니다. 담당 반 수정만 교사 전용입니다(409 `ADMIN_NOT_TEACHER`). 학생 관리자가 졸업·자퇴로 나와도 활동 중인 관리자가 그 사람뿐이면 학적 동기화·로그인에서 휴면 처리하지 않고 남깁니다(관리자 API로는 되돌릴 수 없어서). 다른 관리자를 정하면 다음 동기화 때 휴면 처리됩니다. 관리자 행을 모두 잠근 뒤(`is_admin` 인덱스로 관리자 행만) 세어, 동시에 회수해도 활동 중인 관리자가 한 명은 남습니다(409 `ADMIN_LAST_ADMIN`).
- 교사 담당 반은 교사가 직접 바꾸는 것과 같은 처리를 쓰고, 감사 로그 행위자는 관리자입니다.
- XP 조정(`POST /admin/users/{userId}/xp-adjustments`, Idempotency-Key)은 한 번에 ±100,000까지, 사유 필수, 조정 뒤 0 미만이면 400 `ADMIN_XP_NEGATIVE`입니다. 원장에 `ADMIN_ADJUST`로 남고, 하루 상한을 적용하지 않으며 상한 계산과 결과 화면의 오늘 합계(`todayTotal`)에도 넣지 않습니다(XP 내역·랭킹 재구성에는 들어감). 랭킹은 0 아래로 내려가지 않게 조정하고 늘어날 때만 도달 시각을 바꿉니다.

### 제재

- `POST /admin/sanctions`(Idempotency-Key): 경고·XP 회수·정지(기간 필수)·영구 정지. 사유는 필수이고 사용자에게 안내됩니다. 자기 자신은 409 `ADMIN_SELF_ACTION`입니다.
  - 경고·XP 회수는 `SANCTION` 알림을 보냅니다. XP 회수는 가진 만큼만 `ADMIN_ADJUST`(음수)로 회수하고 랭킹에도 반영합니다.
  - 정지·영구 정지는 계정을 `SUSPENDED`로 바꾸고 모든 기기에서 로그아웃시킵니다. 이미 받은 액세스 토큰도 Valkey 차단 표시(`auth:blocked:{userId}`, 토큰 수명만큼)로 바로 막고(403 `ACCOUNT_SUSPENDED`), 열린 WebSocket은 다음 메시지에서 끊습니다(닫힘 코드 4403). 차단 표시는 커밋 전에 두고 실패하면 지웁니다. Valkey가 응답하지 않으면 차단 확인은 통과시킵니다(리프레시는 계정 상태로 막힘). 사유와 기간은 로그인할 때 안내됩니다.
  - 정지 기간이 지나면 다음 로그인 때 활동 상태로 돌아옵니다.
- `PATCH /admin/users/{userId}/status`: 정지는 제재와 같은 처리(기간이 없으면 영구 정지)이고, 해제(`ACTIVE`)는 정지와 차단 표시만 풉니다(409 `ADMIN_NOT_SUSPENDED`). 제재 이력은 사용자 상세에 최신순으로 나옵니다.

### 신고 처리

- 신고는 대상별 묶음(`report_groups`)에 쌓입니다. 대상마다 열린 묶음은 하나이고(`(대상, open_key)` 유니크, 동시에 신고해도 하나만 생김), 처리를 끝내면 묶음을 닫아 그 뒤의 신고는 새 묶음이 됩니다.
- `GET /admin/reports`(상태·사유·마지막 신고 기간 필터, 최근 신고순)와 `GET /admin/reports/{reportGroupId}`(개별 신고, 대상이 받은 신고 전체 수와 제재 이력, 처리 결과·변경 이력). 신고한 사람은 관리자에게도 보여 주지 않습니다.
- `PATCH /admin/reports/{reportGroupId}`: 완료(`RESOLVED`)에는 결과·메모가 필수입니다. 처음 완료할 때 신고한 사람들에게 `REPORT_RESULT` 알림을 한 번 보냅니다(문제 없음 / 조치함). 완료한 뒤에는 결과·메모만 고칠 수 있고(409 `REPORT_ALREADY_RESOLVED`), 바꿀 때마다 이력·감사 로그가 남습니다. 제재는 `POST /admin/sanctions`를 `reportGroupId`와 함께 따로 호출합니다.

### 부정 의심 사용자

- 매일 04:30(KST) `suspicious` 큐 작업이 전날 활동을 보고 `suspicious_flags`에 표시만 합니다. 제재는 관리자가 정합니다. `POST /admin/jobs/SUSPICIOUS_DETECT/run`으로 직접 돌려도 전날 기준이고, 같은 사용자·사유·날짜는 한 번만 표시합니다(유니크 키, 다시 돌려도 이미 있는 표시는 그대로).
- 기준(임시값, `src/modules/suspicious/suspicious-rules.ts`):
  - `FAST_ANSWERS`: 그날 학습 답이 30개 이상이고, 그중 너무 빨리 낸 답(0.5초 미만, 점수·XP에서 빠지는 답)이 절반 이상
  - `REPEATED_OPPONENT`: 같은 상대와 하루에 4번 이상 대결(XP는 3번까지만 받음). 두 사람 모두 표시
  - `XP_SPIKE`: 하루 XP 상한(500, 관리자 조정 제외)을 3일 이상 연속으로 채움
- `GET /admin/suspicious-users`: 사용자·활동한 날별로 묶어(사유 목록, 사유별 근거 수치, 처음 감지한 시각, 모두 확인했는지) 최근 날짜부터 보여 줍니다. 사유·확인 여부·활동 날짜 기간으로 거릅니다.
- `PATCH /admin/suspicious-users/{userId}/{date}`: 그날 그 사용자의 표시를 모두 확인함(또는 취소)으로 바꾸고 확인한 관리자·시각과 감사 로그를 남깁니다(404 `SUSPICIOUS_NOT_FOUND`).

### 금칙어 관리

- `GET/POST /admin/forbidden-words`, `PATCH/DELETE /admin/forbidden-words/{wordId}`: 금칙어(`FORBIDDEN`)와 오탐 방지용 허용 단어(`ALLOWED`). 앞뒤 공백을 지우고, 같은 종류에 같은 단어는 409 `ADMIN_FORBIDDEN_WORD_DUPLICATE`입니다. 등록한 관리자와 감사 로그가 남습니다.
- 바꾸면 Valkey의 `forbidden-words:version`을 새 무작위 값으로 바꿉니다. 서버마다 가진 금칙어 캐시는 이 버전을 1초에 한 번 확인해 바뀌었으면 다시 읽습니다(바꾼 서버는 즉시, 다른 서버는 1초 안에 반영). 버전을 읽지 못하면 5초 동안 다시 묻지 않고 1분 만료로 갱신합니다.

### 앱 설정

- `GET/PUT /admin/app-config`: 점검 모드(켜기·문구·끝나는 시각), 플랫폼별 최소·최신 버전, 스토어 주소를 통째로 바꿉니다. 버전 형식과 최소 ≤ 최신을 검사합니다(400). 바꾸면 감사 로그에 이전·이후 값이 남고, 서버마다 5초 캐시라 모든 서버에 5초 안에 반영됩니다.
- 점검 중에도 관리자는 모든 API를 쓸 수 있어 점검을 풀 수 있습니다(`GET /app/status`와 로그인도 열려 있음).

### 약관 버전

- `GET /admin/policies`(시행 전 버전 포함)와 `POST /admin/policies`(종류·버전·제목·내용·시행일·재동의 필요 여부). 시행일은 지금 이후만 받습니다. 필수 여부를 비우면 새 버전 바로 앞 버전을 따릅니다. 같은 종류에 같은 버전은 409 `POLICY_VERSION_EXISTS`, 같은 시행일은 409 `POLICY_EFFECTIVE_AT_EXISTS`입니다.
- 시행일이 되면 현재 약관이 되고, 재동의가 필요한 버전이거나 선택 약관이 필수로 바뀐 버전이면 그 뒤 첫 요청부터 약관 동의를 안내합니다(서버마다 약관 캐시 1분). 고지 공지(시행 7일 전, 불리한 변경은 30일 전)는 공지로 따로 등록합니다.

### 오늘의 문장 관리

- 상태: 등록하면 `PENDING_REVIEW`(검수 대기) → 게시 예약하면 `SCHEDULED` → 날짜가 되면 06:00 작업이 `PUBLISHED`로 바꿉니다. 게시 예약할 때 날짜가 이미 오늘(06:00 기준) 이전이면 바로 게시합니다. 게시를 취소하면 검수 대기로 돌아가고 앱에서 사라집니다.
- `POST /admin/morning/parse`: 게시물 본문을 저장하지 않고 분석합니다. 줄마다 `머리말: 내용`이고 칸은 `|`로 나눕니다.

```text
문장: Persistence is the key.
뜻: 꾸준함이 열쇠다.
어휘: persistence | 끈기, 꾸준함 | Her persistence paid off.
퀴즈 빈칸: _____ is the key. | Persistence | 해설(선택)
퀴즈 뜻: key의 뜻은? | 열쇠 / 문 / 창 | 열쇠 | 해설(선택)
```

- `POST /admin/morning`: 날짜당 하나, 있으면 409 `MORNING_DATE_EXISTS`(`replace: true`면 게시 전 문장을 교체, 게시된 날짜는 409 `MORNING_ALREADY_PUBLISHED`). 어휘·퀴즈는 비어 있어도 저장되고, 강조 위치를 비우면 문장에서 처음 나오는 위치로 채웁니다.
- `PATCH /admin/morning/{id}`: 보낸 항목만(어휘·퀴즈는 통째로) 바꿉니다. 예약·게시된 문장은 바꾼 뒤에도 게시할 수 있어야 하고(400), 게시된 문장의 날짜는 바꿀 수 없습니다. 이미 푼 사용자의 기록(정답 수)은 그대로입니다.
- `POST /admin/morning/{id}/publish`: 문장·뜻·어휘·퀴즈가 다 있어야 하고(400 `MORNING_INCOMPLETE`), 빈칸 정답이 문장에 있어야 하며(400 `MORNING_BLANK_NOT_IN_SENTENCE`), 강조 위치·객관식 정답이 맞아야 합니다(400 `MORNING_INVALID`). `detail.issues`에 문제 목록이 담깁니다. 시드도 같은 검사를 씁니다.

### 시즌 관리

- 시즌은 기간이 끝나면 자동으로 마감·확정합니다(관리자 확정 없음). 관리자는 결과를 보고 제외 대상을 정하거나 실패한 마감을 다시 돌립니다.
- `GET /admin/seasons`(주간·월간, 상태 필터, 최근 시즌순): `endDate`는 마지막 날(포함), `closedAt`은 확정 시각입니다. `pendingReportCount`는 그 시즌 학교 순위에 든 사용자(제외된 사용자 포함)가 대상인 처리 전(`RECEIVED`·`IN_REVIEW`) 신고 묶음 수로, 조회할 때 기준입니다. 시즌 기간에 부정 의심 표시가 있는 순위 사용자 수(`suspiciousCount`)와, 상세 순위마다 의심 여부(`suspicious`)도 보여 줍니다.
- `GET /admin/seasons/{seasonId}`: 학교 범위를 마감 순서대로 100위까지(그 사이의 제외된 사용자도 `rank: null`, `excluded: true`로 함께), 제외 대상 전체(사유·관리자·시각), FAILED일 때 실패 사유. 없으면 404 `ADMIN_SEASON_NOT_FOUND`입니다.
- `PUT /admin/seasons/{seasonId}/exclusions`: 제외 대상을 통째로 바꿉니다(최대 100명, 사유 필수, 빈 배열이면 모두 해제). 상태와 관계없이 바꿀 수 있고, 같은 트랜잭션에서 그 시즌의 학교·학년·반 순위를 마감과 같은 규칙으로 다시 매깁니다. 계속 제외되는 사용자는 처음 사유를 그대로 두고, 없는 사용자는 404 `USER_NOT_FOUND`입니다.
- `POST /admin/seasons/{seasonId}/rerun`: `FAILED`만(409 `ADMIN_SEASON_NOT_FAILED`) `ranking` 큐에 `close-season` 작업으로 넣고 202를 돌려줍니다. 진행은 `GET /admin/jobs`의 `SEASON_CLOSE`에서 봅니다. 따라잡는 기간보다 오래된 시즌도 다시 돌릴 수 있지만, 지난 ZSET이 만료됐으면 빈 스냅샷으로 확정됩니다.
- 제외 대상 변경과 다시 실행은 감사 로그에 남습니다.

### 정기 작업

- 정기 작업(정리, 시즌 마감, 챌린지 생성, 예약 알림, 학적 동기화, 부정 감지)은 실행할 때마다 `job_runs`에 시작·끝·상태·오류·실행 방식(정기/수동)을 남기고, 7일 지난 기록은 매일 정리에서 지웁니다. 작업 목록은 `src/modules/jobs/job-registry.ts`입니다.
- 시즌 마감이 실패하거나(한 시즌이라도 확정하지 못하면) 학적 동기화가 실패하면 실패로 남기고 활동 중인 관리자 모두에게 `ADMIN_ALERT`를 보냅니다(실패가 이어지는 동안은 처음 한 번만).
- `GET /admin/jobs`: 작업마다 주기, 마지막 실행·상태·오류, 다음 정기 실행. `POST /admin/jobs/{job}/run`: 큐에 넣고 바로 202를 돌려주고, 실행 중이거나 30초 안에 다시 누르면 409 `ADMIN_JOB_RUNNING`, 정해진 시각에 보내는 알림 작업(리마인더·오늘의 문장 알림·주간 결과·순위 하락)은 409 `ADMIN_JOB_SCHEDULE_ONLY`입니다(1시간 넘게 RUNNING이면 서버가 꺼진 것으로 보고 다시 실행 가능).

### 학적 동기화

매일 04:00(KST, `datagsm-sync` 큐)에 DataGSM OpenAPI `GET /v1/students`(졸업생·자퇴생 포함, 1000명씩 페이지)로 학적을 맞춥니다. `POST /admin/jobs/DATAGSM_SYNC/run`으로 직접 실행할 수도 있습니다.

- 우리 서비스에 가입한 학생만 맞추고 계정은 새로 만들지 않습니다. 교사는 건드리지 않습니다.
- 학생 목록은 계정 ID가 아닌 학생 ID를 주므로 `users.datagsm_student_id`(로그인할 때 저장)로 찾고, 아직 없는 사용자는 이메일로 찾아 학생 ID를 채웁니다(같은 이메일의 계정이 여럿이면 맞추지 않음). 다른 계정에 붙은 학생 ID는 본인이 로그인할 때 가져옵니다.
- 학년·반·번호가 모두 있을 때만 학년·반·번호·학번을 바꿉니다(DataGSM에서 정보 수정 요청 중인 재학생은 비어 있어 그대로 둠, 학번만 비어 있으면 학번은 남김). 이름도 맞춥니다.
- 졸업·자퇴로 나온 활동 중 학생은 휴면(`INACTIVE`)으로 바꾸고 모든 기기에서 로그아웃시킵니다. 마지막 학년·반은 남깁니다. 휴면이던 학생이 재학으로 나오면 다시 `ACTIVE`입니다(로그인과 같은 규칙).
- 목록에서 빠진 학생은 DataGSM 오류일 수 있어 휴면 처리하지 않습니다. 정지된 학생은 학적만 바꾸고 상태는 그대로, 탈퇴한 사용자는 건드리지 않습니다.
- 재학생의 반이 `classes`에 없으면 만듭니다.
- 학년·반이 바뀌면 이번 주·이번 달·전체 랭킹 점수를 옛 학년·반 키에서 새 키로 옮깁니다(학교 키 점수 기준). 동기화 전에 로그인해서 바뀐 경우도 로그인에서 옮깁니다.
- 사용자마다 행을 잠근 트랜잭션으로 바꾸고, 200명씩 나눠 맞춥니다. 결과(`fetched`, `matched`, `updated`, `deactivated`, `reactivated`, `classesCreated`, `skipped`, `failed`)는 `job_runs.result`에 남고, 일부 사용자가 실패하면 같은 건수가 `job_runs.error` 메시지에 담깁니다. `skipped`는 탈퇴한 사용자와 학년·반·번호가 비어 학적을 그대로 둔 학생 수입니다. DataGSM 응답에서 형식이 틀린 학생은 건너뛰고 경고 로그만 남깁니다. 로그인도 학년·반·번호가 다 있을 때만 학적을 바꿉니다.
  - 알려진 한계: 동기화가 학년·반을 옮기는 바로 그 순간에 XP가 더해지면 그 XP가 옛 반 점수에 남을 수 있고(학교 점수는 정확, `pnpm ranking:rebuild`로 복구), 동기화 도중 로그인한 학생은 시작할 때 받은 목록 값으로 다시 덮일 수 있습니다(다음 로그인·동기화 때 바로잡힘). 한 사용자 반영이 실패해도 나머지는 끝까지 반영하고, 실패한 사용자가 있으면 건수를 담아 실패로 남깁니다.
- `DATAGSM_API_KEY`가 없으면 경고 로그만 남기고 성공(`{ disabled: true }`)으로 끝냅니다. DataGSM 요청이 하나라도 실패하면 아무것도 바꾸지 않고 실패로 남깁니다. 실패하면 관리자에게 알립니다.
