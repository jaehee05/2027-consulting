# 뿌리오 알림톡 자동화 배포 가이드

Firebase Cloud Functions 를 통해 뿌리오 알림톡 자동 발송을 구성합니다. 아래 순서대로 **딱 한 번만** 수행하면 이후엔 관리자 페이지 "알림톡" 탭에서 전부 관리됩니다.

---

## 1. 사전 준비

1. **Firebase Blaze 플랜** (완료)
2. **Node.js 20+ 설치** — https://nodejs.org (LTS 다운로드, Windows installer)
3. 설치 확인: PowerShell 열고 `node -v` → `v20.x.x` 떠야 함

---

## 2. Firebase CLI 설치 & 로그인

PowerShell에서:

```bash
npm install -g firebase-tools
firebase login
```

브라우저가 열리면 Firebase 계정으로 로그인하고 승인.

---

## 3. 의존성 설치

프로젝트 폴더(`2027-consulting`)로 이동한 뒤:

```bash
cd functions
npm install
cd ..
```

---

## 4. 배포 (Firestore 규칙 + Functions)

```bash
firebase deploy --only firestore:rules,functions
```

최초 배포 시 **2~5분** 정도 걸립니다. Cloud Run / Artifact Registry / Eventarc API 활성화 알림이 나오면 **Y** 눌러 허용.

배포 완료 후 터미널에 다음과 같이 출력됩니다:

```
Function URL (ppurioAdmin(asia-northeast3)):
https://ppurioadmin-xxxxxxxxxx-an.a.run.app
```

**이 URL을 복사**하세요.

---

## 5. index.html 에 URL 붙여넣기

`index.html` 상단에서 아래 줄을 찾습니다 (약 266번째 줄):

```js
const PPURIO_ADMIN_URL = 'REPLACE_AFTER_DEPLOY';
```

`REPLACE_AFTER_DEPLOY` 를 4단계에서 복사한 URL 로 교체:

```js
const PPURIO_ADMIN_URL = 'https://ppurioadmin-xxxxxxxxxx-an.a.run.app';
```

저장. 호스팅 사용 중이면 파일을 재배포하고, GitHub Pages 등이면 push.

---

## 6. 관리자 페이지에서 뿌리오 설정

1. 사이트 접속 → ADMIN 로그인
2. 상단 **알림톡** 탭 클릭
3. 입력:
   - **뿌리오 계정** (계정 ID)
   - **발신프로필명**
   - **API 키** (연동 개발 인증키)
   - **알림톡 자동 발송 활성화** 체크
4. 8개 템플릿 각각:
   - **템플릿 코드**: 뿌리오에 등록된 템플릿의 코드
   - **changeWord 매핑**: 뿌리오 템플릿에 등록된 변수(`#{변수명}`) → 실제 값 매핑
5. **저장**

### changeWord 작성 예

뿌리오 템플릿 본문이 이렇게 등록돼 있다면:

```
#{학생명}님, #{일시}에 예약이 완료되었습니다.
```

changeWord JSON 에 이렇게 씁니다:

```json
{"#{학생명}":"${name}","#{일시}":"${dateLabel} ${slot}"}
```

사용 가능한 토큰:
- `${name}` — 학생 이름
- `${school}` `${grade}` `${seat}`
- `${dateLabel}` `${slot}` — 현재 예약 (기본 컨텍스트)
- `${currentDateLabel}` `${currentSlot}` — 현재 예약 (명시적)
- `${newDateLabel}` `${newSlot}` — 변경 희망 시간 (변경 요청 시)
- `${reason}` — 학생 사유 / 관리자 거절 사유
- `${offeredSlots}` — 관리자가 제시한 시간대들 (관리자 변경 요청 시)

---

## 7. 테스트 발송

관리자 페이지 알림톡 탭 하단에서:
1. 이벤트 선택
2. 수신 전화번호 입력 (본인 번호 추천)
3. **테스트 발송** 클릭

뿌리오 응답이 화면 하단에 JSON으로 뜨면 성공. 카카오톡 도착 여부 확인.

---

## 8. 실제 동작 확인

학생 계정으로 예약을 하나 만들어 보세요. Firestore `bookings` 컬렉션에 문서가 생기면 자동으로 `bookingComplete` 알림톡이 발송됩니다.

로그 확인:

```bash
firebase functions:log
```

---

## 문제 해결

- **"PPURIO_ADMIN_URL이 설정되지 않았습니다"** — 5단계 누락. index.html 재배포 확인.
- **401 "관리자 인증 실패"** — 로그인한 ADMIN 계정 비밀번호가 Firestore `admins/{id}.password` 와 일치하는지 확인.
- **토큰 발급 실패** — 뿌리오 계정/API키 오타. API키는 뿌리오 콘솔에서 재발급 가능.
- **템플릿 코드 오류** — 뿌리오에 등록된 템플릿이 **검수 완료** 상태인지 확인.
- **관리자 UI에 "설정 불러오기 실패"** — Function이 아직 배포되지 않았거나 URL이 잘못됨. `firebase deploy --only functions` 재실행.

---

## 재배포 (코드 수정 시)

Functions 코드만 수정:
```bash
firebase deploy --only functions
```

Firestore 규칙만 수정:
```bash
firebase deploy --only firestore:rules
```
