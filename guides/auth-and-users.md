# 인증·사용자

## 인증

1. 클라이언트가 PKCE로 DataGSM 로그인 → 인가 코드 수신
2. `POST /auth/datagsm { code, codeVerifier, redirectUri }` → 액세스 토큰(30분)·리프레시 토큰(30일)·`nextStep`·`user`
3. API 호출: 앱은 `Authorization: Bearer {accessToken}`, 웹은 쿠키(`__Host-at`) 자동 전송
4. `AUTH_TOKEN_EXPIRED`(401)이면 `POST /auth/refresh` 1회 후 재시도. 리프레시 토큰은 매번 새로 바뀜
5. `POST /auth/logout`: 리프레시 토큰만 있으면 됨 (앱은 본문 `refreshToken`, 웹은 쿠키)

웹은 토큰을 응답 본문 대신 HttpOnly 쿠키로 받습니다.

- DataGSM 인가 요청의 scope: `datagsm:account_read datagsm:student_read` (없으면 사용자 정보 조회 403 또는 학년·반 누락)
- 클라이언트 없이 로그인 확인: `pnpm datagsm:login` (기본 대상은 개발 서버, 다른 서버는 `pnpm datagsm:login http://localhost:3000`). 브라우저로 DataGSM 로그인 → `POST /auth/datagsm` → `GET /users/me` → 로그아웃까지 실행합니다. 서버의 `DATAGSM_REDIRECT_URIS`에 `http://localhost:8765/callback`이 있어야 합니다.

### 기기

로그인 1회 = 기기 1개(세션)입니다. 액세스 토큰의 `sid`가 기기 ID입니다.

- `POST /devices`: 로그인 직후, 푸시 권한 허용 직후, 푸시 토큰이 바뀔 때 기기 이름과 푸시 정보를 등록. 푸시를 끄면 `pushType: null`
- 플랫폼별 푸시: iOS는 APNS·FCM, Android는 FCM, 웹은 WEBPUSH만 허용
- 같은 푸시 토큰이 다른 기기에 등록돼 있으면 그쪽 등록은 해제됩니다 (공용 기기 대비)
- `DELETE /devices/{deviceId}`: 다른 기기 원격 로그아웃. 그 기기는 액세스 토큰이 만료되는 최대 30분 뒤 로그아웃됨. 현재 기기는 `POST /auth/logout` 사용
- 로그아웃·원격 로그아웃·리프레시 토큰 재사용 감지 시 푸시 등록도 함께 해제됩니다

### 프로필

- `PATCH /users/me/profile { avatarId?, representativeBadgeId? }` → `Me`. 생략한 항목은 그대로 두고, `null`이면 해제합니다(아바타는 `default`로 돌아감). 이름·학번·학년·반은 DataGSM 값이라 바꿀 수 없습니다.
- 목록에 없는 아바타는 400 `USER_AVATAR_NOT_FOUND`, 가지고 있지 않거나 내려간(`active=false`) 배지는 400 `USER_BADGE_NOT_OWNED`입니다. 교사는 아바타만 바꿀 수 있습니다(배지가 없어 대표 배지는 항상 `USER_BADGE_NOT_OWNED`).
- 대표 배지는 `users.representative_badge_id`에 저장합니다. 배지 정의가 지워지면 FK로 비워집니다.
- `GET /users/avatars`: 기본 아바타 목록 `[{ avatarId, imageUrl }]`. 별도 테이블 없이 코드의 `AVATAR_IDS`(src/modules/users/avatars.ts)가 목록이고 지금 값은 임시입니다. `imageUrl`은 배지처럼 앱이 이미지 주소로 바꾸는 키(`avatars/{avatarId}`)입니다. 목록에서 ID를 빼려면 그 ID를 저장한 사용자도 `default`로 바꿔야 합니다.

### 회원 탈퇴

`DELETE /users/me { confirm: true }` → 204. `confirm`이 없거나 false면 400 `USER_WITHDRAW_NOT_CONFIRMED`. 약관 동의·담당 반 선택 전에도 호출할 수 있습니다.

- 유예 기간 없이 바로 파기합니다. 사용자 행은 끝난 대결 결과처럼 다른 사람의 기록이 참조해서 지우지 않고 비웁니다: 상태 `WITHDRAWN`, 이름은 "탈퇴한 사용자", 이메일·학번·학년·반·번호·DataGSM 식별값(계정 ID·학생 ID)·마지막 로그인·정지 정보는 NULL, 관리자 권한·XP·랭킹 공개는 해제, 아바타·대표 배지는 기본값으로. DataGSM 토큰은 원래 저장하지 않습니다.
- 모든 기기(세션·리프레시 토큰·푸시 등록)를 지우고, 남은 액세스 토큰은 Valkey 차단으로 바로 401 `AUTH_INVALID`가 됩니다. 이미 열린 WebSocket은 다음 메시지에서 끊깁니다.
- 지우는 것: 학습 세션·기록·오답노트·암기 진행·일별 통계·연속 학습·즐겨찾기·연습·챌린지 기록·오늘의 문장 완료, XP 원장·배지·미션·지난 시즌 순위·부정 의심 표시, 친구·친구 요청·차단(양쪽 방향), 알림·알림 설정·공지 읽음·약관 동의 이력, 문의(첨부 이미지 파일 포함), 교사의 담당 반 연결.
- 내 단어팩은 단어와 함께 지웁니다. 대결방에 쓰인 팩은 다른 사람의 대결 문항이 단어를 참조하므로 소프트 삭제하고 공유를 끊습니다. 다른 사람이 복사한 팩은 따로 있는 사본이라 그대로 남습니다.
- 남기는 것: 끝난 대결의 결과·답안(다른 참가자에게 "탈퇴한 사용자"로 보임), 내가 하거나 받은 신고, 제재 이력, 관리자로 남긴 감사 로그·처리 기록(이름만 "탈퇴한 사용자"로 보임).
- 이번 기간과 아직 마감 전일 수 있는 지난 기간의 주간·월간·전체 랭킹에서 바로 빠지고 랭킹 목록 캐시도 지웁니다.
- 들어가 있던 대결방에서는 나가기와 같은 규칙으로 자동 퇴장합니다(진행 중이면 남은 문항 0점, 방장이면 다음 참가자에게 넘김). 교사가 진행하던 교사용 방은 닫히고, 빠른 매칭 대기열에서도 빠집니다.
- 활동 중인 마지막 관리자는 409 `USER_LAST_ADMIN`입니다. 다른 관리자를 먼저 지정해야 합니다.
- 같은 DataGSM 계정으로 다시 로그인하면 새 계정(약관 재동의)이 됩니다. 졸업·자퇴로 휴면(`INACTIVE`)이 된 계정은 탈퇴가 아니라 그대로 둡니다.
- 정지 중에 탈퇴하면 `withdrawn_suspensions`에 DataGSM 식별값·정지 종료일(영구 정지는 NULL)·사유만 남기고, 그 기간 동안 로그인하면 403 `AUTH_WITHDRAWN_SUSPENDED`(detail `{ until }`)입니다. 기간이 끝난 행은 로그인에서 무시하고 `daily-cleanup`이 지웁니다.

## 약관

관리자 API가 생기기 전까지는 `policies` 테이블에 직접 넣습니다.

```sql
INSERT INTO policies (id, type, version, title, content, required, require_reagreement, effective_at)
VALUES (UUID_TO_BIN(UUID()), 'TERMS', '1.0', '서비스 이용약관', '# 이용약관 ...', true, false, NOW(3));
```

- 필수(`required`) 약관에 동의하지 않은 사용자는 로그인 `nextStep`이 `TERMS_AGREEMENT`이고, 동의 전까지 대부분의 API가 403 `TERMS_AGREEMENT_REQUIRED`
- 새 버전을 넣을 때 `require_reagreement = true`면 기존 사용자도 다시 동의해야 함
- 서버는 약관 목록을 1분 캐시합니다.
- 공개 API(`@Auth('ALL')`)는 로그인 상태여도 약관 검사를 하지 않습니다.

## 사용자 검색·프로필

- 사용자 검색(`GET /users/search`)은 친구 추가용이라 학생만 씁니다. 이름(가운데 글자 포함) 또는 학번(앞부분)으로 찾고 이름순 cursor 페이지입니다. 응답에 학번은 넣지 않고(랭킹 비공개면 티어도 null) 친구 여부와 대기 중인 친구 요청 방향(`RECEIVED`·`SENT`)을 붙입니다.
- 교사, 나, 나를 차단한 사용자, 정지·휴면·탈퇴 계정은 검색에서 빠집니다. 내가 차단한 사용자는 나옵니다(차단을 풀 수 있게).
- 프로필(`GET /users/{userId}`)은 교사도 봅니다. 랭킹 비공개이거나 정지·휴면 계정이면 남에게는 레벨·티어가 null이고(사용자 요약의 티어도 null), 내 프로필은 보입니다. 교사는 레벨·티어가 없습니다.
- 탈퇴한 사용자는 이름이 "탈퇴한 사용자"이고 학년·반·레벨·티어·대표 배지가 null입니다. 나를 차단한 사용자와 없는 사용자는 똑같이 404 `USER_NOT_FOUND`입니다. 관계(`relation`)의 `isBlocked`는 내가 차단했는지입니다.
- 대표 배지는 배지 목록과 같게 공개 프로필과 내 프로필에서만 보입니다. 숨긴 배지나 더는 갖고 있지 않은 배지는 null입니다.

## 친구

- 학생끼리만 맺습니다(교사 403 `FRIEND_NOT_ALLOWED`, 정지·탈퇴·휴면이거나 없는 사용자 404 `USER_NOT_FOUND`). 한도는 `FRIEND_LIMIT`(임시 100명)이고 요청·수락 때 양쪽 모두 확인합니다.
- `friend_requests`는 보낸 사람→받는 사람 한 쌍에 하나, `friendships`는 방향마다 한 행(양쪽 두 행)입니다. 친구 삭제는 두 행을 함께 지웁니다.
- 상대가 이미 나에게 요청했으면 요청을 만들지 않고 바로 친구가 되며(`requestId: null`), 먼저 요청한 사람에게 수락 알림을 보냅니다.
- 요청·수락은 두 사용자 행을 id 순서로 잠가 서로 동시에 요청해도 한쪽만 처리되고 한도를 넘지 않습니다. 거절·취소는 상대에게 알리지 않습니다.
- 친구 목록은 친구가 된 순서(최근 먼저)이고 페이지네이션이 없습니다. 랭킹 `FRIENDS` 범위는 나와 친구입니다.

## 차단

- 학생이 다른 학생을 차단합니다(교사 403 `BLOCK_NOT_ALLOWED`, 탈퇴했거나 없는 사용자 404 `USER_NOT_FOUND`). 상대에게 알리지 않고, 차단 목록은 차단한 사람만 봅니다.
- 차단하면 두 사람의 친구 관계와 대기 중인 친구 요청(양쪽 방향)을 지웁니다. 풀어도 친구는 되살리지 않습니다. 친구 요청·수락과 같은 순서로 두 사용자 행을 잠가 차단과 동시에 친구가 되지 않습니다.
- 어느 쪽이든 차단했으면 친구 요청이 403 `FRIEND_NOT_ALLOWED`(차단 사실을 드러내지 않는 같은 문구)이고, 빠른 매칭에서 서로 짝짓지 않습니다.
- 대결방 리액션은 보낸 사람을 차단한 사람에게 보내지 않습니다. 초대 코드로 같은 방에 들어오는 것은 막지 않습니다.

## 신고

- 로그인한 사용자는 사용자·단어팩·단어를 신고합니다(`POST /reports`). 사유는 부적절한 내용·불쾌한 리액션·부정행위·기타이고, 기타는 상세가 필수(200자 이하, 앞뒤 공백 제거)입니다.
- 나 자신·내 단어팩(그 안의 단어)은 400 `REPORT_SELF`, 없거나 탈퇴했거나 내가 볼 수 없는 대상(공유하지 않은 남의 단어팩)은 404 `REPORT_TARGET_NOT_FOUND`입니다.
- 대결 중 일어난 일이면 `battleId`를 붙이고, 내가 참여한 대결이 아니면 404 `BATTLE_NOT_FOUND`입니다.
- 같은 대상·사유는 하루(KST) 한 번입니다(429 `REPORT_DUPLICATE_TODAY`). 유니크 키로 막아 동시에 보내도 하나만 남습니다.
- 신고는 `RECEIVED` 상태로 쌓이고, 처리·결과 알림은 관리자 기능에서 합니다. 신고 대상에게는 알리지 않으며 신고한 사람을 드러내는 API가 없습니다.
