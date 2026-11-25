# 고객지원

## 고객지원

### FAQ

- `GET /faqs`: 로그인 없이(점검 중에도) 분류 순, 분류 안에서는 순서대로 보여 줍니다. 분류로 거를 수 있습니다.
- `POST /admin/faqs`, `PATCH/DELETE /admin/faqs/{faqId}`: 순서를 비우면 그 분류의 맨 뒤에 붙습니다. 수정은 보낸 항목만 바꾸고, 바꿀 때마다 감사 로그가 남습니다.

### 공지

- `GET /notices`: 고정 공지 먼저, 그다음 최신순(커서 `(pinned, id)`), 읽음 여부 포함. `GET /notices/{noticeId}`는 열면 읽음 처리하고, 삭제·비공개 공지는 404 `NOTICE_NOT_FOUND`입니다.
- 관리자: `GET /admin/notices`(초안 포함), `POST`(Markdown, 고정·공개 여부, 푸시 선택), `PATCH`, `DELETE`(소프트 삭제). 푸시를 고르면 공개 공지일 때 활동 중인 모든 사용자에게 `NOTICE` 알림을 보냅니다(공지 알림을 끈 사람은 알림 설정에서 걸러짐, 1000명씩 나눠 저장). 바꿀 때마다 감사 로그가 남습니다.

### 1:1 문의

- `POST /inquiries`(multipart/form-data, Idempotency-Key 필수): `type`·`title`(1~50자)·`content`(10~1000자)와 `images` 필드로 이미지 3장까지, 한 장에 5MB까지 받습니다. 앱 버전·플랫폼은 `X-Client-Platform`·`X-Client-Version`에서 저장합니다.
- 이미지는 확장자·Content-Type이 아니라 파일 앞부분의 시그니처로 형식을 판단해 JPEG·PNG·WebP만 받고, sharp로 같은 형식으로 다시 인코딩해 EXIF(위치 정보 포함)를 지웁니다(회전 정보는 픽셀에 먼저 적용). 디코딩 메모리 때문에 2500만 픽셀까지만 받고, 서버마다 한 장씩 차례로 처리합니다. HEIC는 sharp 기본 빌드에 HEVC 디코더가 없어 400 `INQUIRY_IMAGE_INVALID`로 거절하니 앱에서 JPEG로 바꿔 보냅니다. 5MB를 넘으면 400 `INQUIRY_IMAGE_TOO_LARGE`, 4장 이상이거나 필드가 틀리면 400 `INVALID_REQUEST`입니다.
- 한 사람이 첫 문의부터 1시간 동안 5건까지(임시값, Valkey 카운터 `inquiry:rate:{userId}`) 남길 수 있고, 넘으면 429 `INQUIRY_TOO_FREQUENT`(Retry-After)입니다. 검증에 실패한 요청은 세지 않습니다.
- 이미지는 서버 디스크 `UPLOAD_DIR`(기본 `./uploads`) 아래 `inquiries/{imageId}`에 둡니다. 개발 서버는 named volume `uploads`를 `/app/uploads`에 붙입니다. 파일을 먼저 쓰고 DB에 저장하며, 저장에 실패하면 파일을 지우고, 서버가 중간에 멈춰 남은 파일은 정리 작업이 지웁니다.
- `GET /inquiries`(내 문의, 최신순 커서), `GET /inquiries/{inquiryId}`(본인 문의만, 관리자는 모든 문의, 아니면 403 `FORBIDDEN`, 없으면 404 `INQUIRY_NOT_FOUND`). 이미지는 10분 동안 유효한 서명 주소 `/inquiries/images/{imageId}?exp=..&sig=..`로 내줍니다. 서명은 `HMAC-SHA256(imageId.exp)`이고, 키는 `UPLOAD_SIGNING_SECRET`이 없으면 `JWT_PRIVATE_KEY`에서 HMAC으로 유도합니다. 서명이 권한이라 이 주소는 로그인·클라이언트 헤더 없이 `<img src>`로 열리고(웹에서도 보이게 `Cross-Origin-Resource-Policy: cross-origin`), 만료·변조되면 403 `INQUIRY_IMAGE_URL_INVALID`입니다.
- 관리자: `GET /admin/inquiries`(상태·종류 필터, 최신순 페이지, 작성자·플랫폼·앱 버전 포함). 상세는 `GET /inquiries/{inquiryId}`로 봅니다. `POST /admin/inquiries/{inquiryId}/answer`는 답변을 쓰고 상태를 `ANSWERED`로 바꾸며, 다시 호출하면 답변을 고칩니다(`answeredAt`은 마지막으로 쓴 시각). 처음 답할 때만 작성자에게 `INQUIRY_ANSWERED` 알림을 보내고, 쓸 때마다 감사 로그(`INQUIRY_ANSWER`)가 남습니다.
