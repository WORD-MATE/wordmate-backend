# 단어팩·학습

## 단어팩

- 내 단어팩은 사용자당 50개, 이름은 1~30자이고 삭제되지 않은 내 팩끼리 겹칠 수 없습니다 (대소문자 무시).
- 기본 단어팩(`type=DEFAULT`)은 관리자만 만들고 고칩니다. 추천순은 기본 팩이면 `sort_order`, 내 팩이면 최근 수정순입니다.
- 삭제는 소프트 삭제(`deleted_at`)이고 공유 코드도 함께 지웁니다.
- 분류와 기본 단어팩은 시드 파일로 넣습니다(아래 "기본 단어팩 시드"). 금칙어는 관리자 API가 생기기 전까지 DB에 직접 넣고, 서버는 1분 캐시합니다.

```sql
INSERT INTO pack_categories (id, name, sort_order) VALUES (UUID_TO_BIN(UUID()), '수능', 1);
INSERT INTO forbidden_words (id, word, type) VALUES (UUID_TO_BIN(UUID()), '금칙어', 'FORBIDDEN');
INSERT INTO forbidden_words (id, word, type) VALUES (UUID_TO_BIN(UUID()), 'class', 'ALLOWED');
```

- 금칙어는 대소문자·전각·공백·기호를 무시한 부분 일치이고, 허용 단어(`ALLOWED`) 안에 든 경우는 통과합니다. 팩 이름·설명은 항상, 단어는 공유할 때 검사합니다.

### 기본 단어팩 시드

- 형식은 [seeds/default-packs.example.json](../seeds/default-packs.example.json)을 따릅니다. `categories`(이름, 정렬 순서)와 `packs`(이름, 분류 이름, 설명, 정렬 순서, 단어)로 구성됩니다. 단어 규칙은 앱과 같습니다(영어 50자, 뜻 1~5개, 팩당 1000개, `example`·`derivatives`는 선택).
- 분류·팩은 이름으로, 단어는 팩 안에서 영어(대소문자 무시)로 찾습니다. 그래서 같은 파일을 여러 번 넣어도 결과가 같고, 파일을 고치면 바뀐 것만 반영됩니다.
- 파일에 없는 단어는 기본으로 남깁니다(관리자가 API로 추가한 단어 보호). `--prune`을 주면 파일에 없는 단어를 지웁니다(소프트 삭제).
- 파일에서 팩 이름을 바꾸면 새 팩이 만들어지고 예전 이름의 팩은 그대로 남습니다(학습 기록·오답이 그 팩을 가리킴). 이름을 바꾸려면 먼저 앱의 단어팩 수정 API로 바꾼 뒤 파일을 맞춥니다.
- 관리자가 API로 추가한 단어와 합쳐 팩당 1000개를 넘으면 그 팩은 반영하지 않고 실패합니다(팩마다 트랜잭션이라 다른 팩은 반영됨).
- 넣기 전에 `--dry-run`으로 형식만 검사할 수 있습니다. 잘못된 곳이 있으면 위치와 이유를 출력하고 아무것도 넣지 않습니다.

```bash
# 로컬
pnpm db:seed seeds/default-packs.json --dry-run
pnpm db:seed seeds/default-packs.json

# 서버 (seeds 폴더는 이미지에 들어 있음)
docker compose run --rm migrate dist/seed.js seeds/default-packs.json
```

### 단어

- 한 팩에 1000개까지. 영어 50자, 뜻 1~5개(각 100자, 중복 불가, 첫 번째가 대표 뜻)입니다.
- 같은 단어 판정은 대소문자·연속 공백·전각을 무시합니다 (`english_norm`, `utf8mb4_bin` 비교라 악센트는 구분).
- `POST /packs/{id}/words`는 여러 개를 한 번에 받습니다. 이미 있는 단어는 `duplicatePolicy`(SKIP·OVERWRITE)를 따르고, 요청 안에서 겹치면 처음 것만 씁니다. 한도를 넘는 단어는 에러 없이 `excluded`로 알려줍니다. `Idempotency-Key`를 지원합니다.
- `example`·`derivatives`는 기본 단어팩에만 저장하고, 내 단어팩에 보내면 버립니다.
- `POST /packs/{id}/words/parse`는 저장하지 않고 분석만 합니다. 줄마다 처음 나오는 `/`, `,`, 탭 앞이 영어, 뒤가 뜻(쉼표로 여러 개)이고 빈 줄은 건너뜁니다. 1000줄까지 받습니다.
- `POST /packs/{id}/words/import`(multipart `file`)는 CSV·XLSX를 분석만 하고 응답 형식은 parse와 같습니다. 클라이언트가 확인한 행을 `POST /packs/{id}/words`로 저장합니다.
  - 5MB·1000행까지, 1열 영어·2열 뜻. 첫 행이 머리글(`영어`, `단어`, `english` 등)이면 건너뜁니다.
  - 형식은 확장자가 아니라 내용으로 판단합니다 (`PK\x03\x04`면 XLSX, 아니면 UTF-8 CSV). EUC-KR CSV는 `WORD_FILE_ENCODING_INVALID`.
  - XLSX는 ZIP 중앙 디렉터리에서 필요한 파일만 풀고, 푼 크기를 `zlib`의 `maxOutputLength`로 제한합니다 (압축 폭탄 방어). 행이 한도를 넘으면 끝까지 읽지 않고 멈춥니다.
- 삭제는 소프트 삭제입니다 (오답노트·학습 기록이 단어를 참조).

### 공유·복사

- 내 단어팩만 공유할 수 있습니다. `POST /packs/{id}/share`는 이미 공유 중이면 같은 코드를 돌려주고, 단어가 없으면 `PACK_EMPTY`입니다.
- 공유를 켤 때 이름·설명·모든 단어를 금칙어로 다시 검사합니다. 걸리면 `detail.wordId`로 어떤 단어인지 알려줍니다. 공유 중에 추가·수정하는 단어도 검사합니다.
- 공유 코드는 헷갈리는 글자를 뺀 12자 무작위 문자열이고, 링크는 `{SHARE_LINK_BASE}/packs/shared/{코드}`입니다. 공유를 중지했다가 다시 켜면 새 코드가 생겨 예전 링크는 계속 무효입니다.
- 미리보기는 단어 20개까지, `memoryStatus`는 null입니다.
- 복사는 단어까지 통째로 복사한 독립된 내 팩을 만듭니다. 이름이 겹치면 ` (2)`, ` (3)`을 붙입니다. 같은 공유 팩은 한 번만 복사할 수 있고(`pack_copies`), 복사본을 지우면 다시 복사할 수 있습니다. 내가 공유한 팩은 복사할 수 없습니다 (`PACK_COPY_OWN`).

### 검색·즐겨찾기

- `GET /words/search?q=`는 기본 팩 + 내 팩에서 영어나 뜻에 검색어가 들어 있는 단어를 영어 알파벳순으로 돌려줍니다 (대소문자 무시, 부분 일치).
- 뜻은 JSON이라 검색용으로 이어 붙인 `meanings_text`를 따로 저장합니다. 단어를 저장·수정·복사하는 곳에서 함께 채워야 합니다.
- `FULLTEXT(english, meanings_text) WITH PARSER ngram`으로 후보를 좁히고 `LIKE`로 정확히 거릅니다. 2글자보다 짧은 낱말은 ngram 토큰(`ngram_token_size=2`)으로 잡히지 않아 `LIKE`만 씁니다.
  - FULLTEXT 인덱스는 Drizzle이 지원하지 않아 마이그레이션 SQL에만 있습니다. 스키마를 고쳐도 drizzle-kit이 이 인덱스를 알지 못합니다.
  - ngram 파서는 불용어(`a`, `on`, `is` …)가 들어간 토큰을 모두 버리기 때문에 불용어를 끈 채로 인덱스를 만듭니다. 인덱스를 다시 만들 때도 `SET SESSION innodb_ft_enable_stopword = OFF`를 먼저 실행해야 합니다.
- 즐겨찾기(`PUT`·`DELETE /words/{id}/favorite`)는 둘 다 멱등 204입니다. 기본 팩이나 내 팩의 단어만 즐겨찾기할 수 있고, 볼 수 없게 된 단어(삭제·남의 팩)는 목록에서 빠집니다.
- 단어 목록·검색 응답의 `favorite`은 보는 사람 기준입니다.

## 학습

- `POST /study/sessions`에서 서버가 문항과 보기를 만들어 `study_session_questions`에 고정 저장합니다. 이어하기(`GET /study/sessions/{id}`)는 저장된 순서를 그대로 돌려줍니다.
  - 문제 수는 10·20·30·전체이고, 단어 수보다 많으면 전체로 맞춥니다. `shuffle=false`면 단어팩 순서(즐겨찾기는 즐겨찾기한 순서)대로 앞에서부터 냅니다.
  - 4지선다 보기는 정답 + 그 단어의 단어팩에 있는 다른 단어 3개입니다. 보이는 글자(EN_TO_KO는 대표 뜻, KO_TO_EN은 영어)가 정답이나 다른 보기와 같은 단어는 뺍니다. 팩에서 모자라면 이번 학습의 다른 단어로 채우고, 그래도 모자라면 `STUDY_TOO_FEW_WORDS`입니다.
  - TYPING 정답(`accepted_answers`)은 서버에만 두고 내려주지 않습니다.
- 이어할 학습은 팩마다 하나(팩이 없는 즐겨찾기 등은 소스마다 하나)이고, `active_key` 생성 컬럼의 유니크 인덱스로 막습니다. 이미 있으면 `409 STUDY_SESSION_EXISTS`(`detail.sessionId`)이고, `force=true`면 기존 학습을 `ABANDONED`로 바꾸고 새로 만듭니다.
- 저장분은 `expires_at`(마지막으로 답한 뒤 7일)이 지나면 조회·이어하기에서 빠집니다. 같은 팩을 새로 시작하거나 정리 작업이 돌면 `ABANDONED`로 바뀝니다.
- `DELETE /study/sessions/{id}`는 행을 지우지 않고 `ABANDONED`로 바꿉니다.
- `POST /study/sessions/{id}/answers`는 문항마다 채점하고 답안·오답노트·암기 진행을 한 트랜잭션에 반영합니다. 세션 행을 잠가 같은 학습의 답안을 차례로 처리하고, 답을 낼 때마다 만료 시각을 7일 뒤로 늘립니다. `Idempotency-Key`를 지원합니다.
  - TYPING은 앞뒤 공백·대소문자·연속 공백을 무시하고, EN_TO_KO는 띄어쓰기도 무시하고 뜻 중 하나와 같으면 정답입니다.
  - `elapsedMs`가 500ms 미만이면 `counted=false`이고, 연속 정답(암기·오답 졸업)에 넣지 않습니다.
  - CHOICE·TYPING은 다시 내면 `409 STUDY_ANSWER_ALREADY_SUBMITTED`, FLASHCARD는 덮어씁니다.
- 오답노트(`wrong_notes`)는 (단어, 문제 유형)마다 한 행입니다. 틀리면 `wrong_count`를 올리고 연속 정답을 0으로 되돌립니다(졸업했던 항목은 다시 `ACTIVE`). 같은 문제 유형으로 2번 연속 맞히면 자동 졸업합니다. 플래시카드는 문제 유형이 없어 오답노트에 넣지 않습니다.
- 암기 상태(`user_word_progress`, 행이 없으면 NEW):
  - 처음 답하면 LEARNING이 됩니다. 서로 다른 학습에서 3번 연속 맞히면 MEMORIZED입니다(한 학습 안에서는 한 번만 셉니다).
  - 틀리면 연속 정답이 0이 되고, MEMORIZED였으면 LEARNING으로 내려갑니다. 플래시카드의 "알아요"는 정답으로 봅니다.
  - 단어 목록·검색·즐겨찾기의 `memoryStatus`, 단어 목록의 `memoryStatus` 필터, 단어팩의 `progress`·`lastStudiedAt`·`memoryStatusCount`가 이 표를 씁니다.
- `POST /study/sessions/{id}/complete`(`FINISHED`·`QUIT`)는 세션을 한 번만 `COMPLETED`로 바꾸고, 같은 트랜잭션에서 다음을 처리합니다. `Idempotency-Key`를 지원합니다.
  - 기록(`study_records`)과 답한 문항별 결과(`study_record_items`)를 남깁니다. 문항별 결과에는 영어·뜻을 스냅샷으로 저장합니다.
  - 일별 통계(`daily_study_stats`, `daily_studied_words`)를 KST 날짜 기준으로 쌓습니다. 답을 하나도 내지 않은 학습은 통계와 스트릭에서 뺍니다.
  - 스트릭과 XP를 갱신합니다.
- 스트릭(`user_streaks`, `kind=STUDY`)은 답을 1개 이상 낸 학습을 끝내면 그날(KST)을 인정합니다. 어제 이어서 하면 +1, 하루 이상 비면 1부터 다시 셉니다.
- XP는 `xp_ledger` 원장 하나에 모든 출처를 기록합니다. `(사용자, 출처, ref_key)` 유니크로 중복 지급을 막고, `XpService.grant`가 사용자 행을 잠가 하루(KST) 500 상한을 지킵니다. 상한에 걸려 0이 된 지급도 원장에 남깁니다.
  - 학습: 정답당 4지선다 +1, 직접 입력 +2, 오답노트 복습 +1입니다. 너무 빠른 답과 플래시카드는 0입니다.
  - 완주 +10: 팩의 모든 단어를 4지선다·직접 입력으로 `FINISHED`까지 풀면 받습니다(오답이 있어도 됨). 같은 팩은 하루 1회입니다(`ref_key = pack:{packId}:{date}`).
  - `blockedReason`은 사유가 여러 개면 `DAILY_CAP` → `REPEAT_LIMIT`(완주 보너스를 오늘 이미 받음) → `TOO_FAST` → `NOT_COMPLETED`(그만두기) 순으로 하나만 알려줍니다.
- 소스는 `PACK`·`FAVORITE`·`WRONG_NOTE`·`RECORD_WRONG`·`REVIEW` 다섯 가지입니다.
  - `RECORD_WRONG`은 그 기록에서 틀린 단어(4지선다·직접 입력)나 "몰라요"(플래시카드)를 출제 순서대로 냅니다. 남의 기록이면 403, 없으면 `RECORD_NOT_FOUND`입니다.

### 간격 반복 복습

- `user_word_progress`의 `review_stage`·`next_review_on`(KST)으로 일정을 관리합니다. 간격은 1·3·7·14·30일입니다.
  - 처음 답한 단어는 다음 날 복습할 단어가 됩니다.
  - 복습 학습(`source=REVIEW`)에서 복습일이 된 단어를 맞히면 다음 간격으로 넘어가고, 30일 간격까지 통과하면 일정에서 빠집니다(`next_review_on = NULL`).
  - 어디서든 틀리면 다음 날부터 다시 시작합니다. 일반 학습에서 맞힌 것과 너무 빠른 정답은 일정을 바꾸지 않습니다.
- `GET /study/review`는 오늘 복습할 단어 수(최대 30)와 오늘 복습 학습에서 답한 단어 수(`last_reviewed_on`)를 돌려줍니다. `source=REVIEW`는 복습일이 이른 순으로 30개까지 냅니다. 내가 지운 팩·단어는 복습하지 않습니다.

### 기록·통계

- `GET /records`는 최신순이고 `date`(KST)로 그날 기록만 볼 수 있습니다. 팩이 삭제됐거나 팩 학습이 아니면 `pack`의 두 값이 모두 null입니다.
- `GET /records/{id}`는 답한 문항만 돌려줍니다. 영어·뜻은 학습을 끝낸 시점의 스냅샷입니다.
- `GET /stats/streak`의 `current`는 오늘이나 어제까지 이어졌을 때만 저장된 값이고, 끊겼으면 0입니다.
- `GET /stats/calendar?month=YYYY-MM`은 `daily_study_stats`에서 학습한 날만 돌려줍니다. 미래의 달은 400입니다.
- `GET /stats/summary?period=`의 기간은 다음과 같습니다(KST, 오늘까지).
  - `TODAY`: 오늘
  - `WEEK`: 이번 주 월요일부터
  - `MONTH`: 이번 달 1일부터
  - 정답률은 4지선다·직접 입력만으로 계산합니다. `studiedWordCount`는 기간 안의 서로 다른 단어 수입니다(`daily_studied_words`). 그래프(`series`)는 기간 첫날부터 오늘까지 하루씩 채웁니다.

### 오답노트

- `GET /wrong-notes`는 기본으로 `ACTIVE`를 최근에 틀린 순(`last_wrong_at`)으로 보여줍니다. `sort=MOST_WRONG`이면 틀린 횟수 순입니다. 커서는 정렬 키마다 따로 인코딩합니다.
  - 필터: `status`·`questionType`·`packId`·`source`, `from`·`to`(KST 날짜, 마지막으로 틀린 날 기준), `recordId`.
  - `recordId` 필터는 그 기록의 문항별 결과에서 같은 단어·같은 문제 유형으로 틀린 오답을 찾습니다. 남의 기록이면 아무것도 나오지 않습니다.
  - 삭제된 단어의 오답은 다시 풀 수 없어 목록에서 뺍니다. 팩만 삭제됐으면 `pack=null`로 보여줍니다.
- `POST /wrong-notes/delete`(영구 삭제)와 `POST /wrong-notes/graduate`(수동 졸업)는 한 번에 500개까지 받고, 남의 id는 조용히 무시합니다.
- 오답노트로 다시 풀기(`source=WRONG_NOTE`)는 `ACTIVE` 오답이 있는 단어를 최근에 틀린 순으로 한 번씩만 냅니다. 팩이 삭제돼도 단어가 남아 있으면 낼 수 있습니다. 정답 XP는 방식과 상관없이 +1입니다.

## 오늘의 문장

- 하루 경계는 **06:00 KST**입니다(`morningDate`). 06시 전에는 전날 문장이 "오늘"이고, XP 지급 여부(문장 날짜당 한 번)와 연속 기록도 같은 기준입니다. 하루 XP 상한(500)은 다른 XP처럼 자정 기준입니다.
- `PUBLISHED`이면서 날짜가 오늘 이전인 문장만 보입니다. 미래·게시 전·없는 날짜는 404 `MORNING_NOT_FOUND`이고, 오늘 문장이 없으면 `GET /morning/today`가 가장 최근 문장을 `isFallback: true`로 줍니다(하나도 없으면 404, 홈 카드는 null).
- 퀴즈 완료(`POST /morning/{date}/quiz/complete`, 학생, Idempotency-Key)는 모든 문항에 한 번씩 답해야 합니다(400). 빈칸은 앞뒤 공백 제거·대소문자 무시로 허용 정답과 비교합니다.
  - 정답을 미리 내려주므로 XP는 정답 수와 상관없이 **오늘 문장을 처음 끝냈을 때 하루 한 번**(`MORNING_XP`, 임시 10)입니다. 지난 문장은 완료 기록만 남고 XP·연속 기록이 없습니다.
  - 아침 문장 연속 기록은 학습 연속 기록과 따로 `user_streaks`(`MORNING`)에 쌓입니다.
- 핵심 어휘 저장(`POST /morning/{date}/save-words`, 학생, Idempotency-Key)은 `packId`(내 단어팩, 기본·남의 단어팩은 404)와 `newPackName`(새 팩) 중 하나만 받습니다. 새 팩에 넣다 실패하면 만든 팩을 지웁니다. 이미 있는 단어는 건너뛰고, 한도(1000개)를 넘으면 하나도 넣지 않고 409 `PACK_WORD_LIMIT_EXCEEDED`입니다.
- 강조 위치(`highlight`)는 문장 안 UTF-16 코드 단위이고 `end`는 포함하지 않습니다(JavaScript 문자열 인덱스와 같음).

### 오늘의 문장 시드

- 문장 등록·검수·게시 예약은 관리자 기능에서 합니다. 그 전까지는 시드 파일로 넣습니다. 형식은 [seeds/morning.example.json](../seeds/morning.example.json)을 따릅니다.
- 날짜마다 게시 상태로 넣고, 이미 있는 날짜는 내용과 핵심 어휘·퀴즈를 바꿉니다(사용자의 완료 기록은 그대로). 핵심 어휘는 단어 추가와 같은 규칙으로 정규화합니다. 강조 위치가 문장 밖이거나, 핵심 어휘가 겹치거나, 빈칸 정답이 문장에 없거나, 객관식 정답이 보기에 없으면 거절합니다. 이미 게시된 날짜의 퀴즈 수를 바꾸면 옛 문항으로 푸는 앱은 400을 받습니다.

```bash
pnpm db:seed-morning seeds/morning.json --dry-run
pnpm db:seed-morning seeds/morning.json

# 서버
docker compose run --rm migrate dist/seed-morning.js seeds/morning.json
```
