# 관리자 앱 푸시 알림 설정

관리자 폰(iOS 앱)으로 **새 질문 / 추가 질문 / 결제 요청** 알림을 받는 설정입니다.
코드는 전부 들어가 있고, 아래는 **Apple·Firebase 콘솔에서 사람이 해야 하는 부분**입니다.

알림톡과는 다른 경로입니다 — 알림톡은 학생·보호자에게 나가고(건당 비용),
푸시는 관리자 본인 폰에만 갑니다(무료).

---

## 무엇이 언제 오나

| 알림 | 조건 | 누른 뒤 |
|---|---|---|
| **새 질문이 등록됐습니다** | 학생이 질문 스레드를 열었을 때 | 질문 탭 → 그 스레드 |
| **추가 질문이 달렸습니다** | **답변완료** 스레드에 학생이 다시 댓글을 달았을 때 | 질문 탭 → 그 스레드 |
| **토큰 결제 요청** | 학생이 결제를 요청했을 때 | 결제 요청 탭 |

"추가 질문"이 따로 있는 이유: 그 스레드는 상태가 **답변완료 그대로**라, 목록의 답변대기 필터만 보고 있으면 놓칩니다.

받는 사람은 **앱에 관리자 계정으로 로그인한 기기 전부**입니다. 학생 계정으로 로그인하면 그 기기의 등록은 지워집니다(학원 공용 기기 대비).

---

## 1. Firebase — iOS 앱 등록

1. [Firebase Console](https://console.firebase.google.com/project/consulting-dd53f) → **프로젝트 설정** → **내 앱** → **iOS 앱 추가**
2. 번들 ID: `kr.kjhedu.consulting2027` (`mobile/capacitor.config.ts` 의 `appId` 와 반드시 같아야 함)
3. `GoogleService-Info.plist` 다운로드 → `mobile/ios/App/App/GoogleService-Info.plist` 로 저장
4. **Xcode 에서 App 타깃에 끌어다 넣기** — 폴더에 복사만 하면 앱 번들에 안 들어가고, 실행하자마자 Firebase 초기화에서 죽습니다. 넣을 때 *Copy items if needed* + *Target: App* 체크.

## 2. Apple — APNs 인증 키

1. [Apple Developer](https://developer.apple.com/account/resources/authkeys/list) → **Keys** → **+**
2. 이름 아무거나, **Apple Push Notifications service (APNs)** 체크 → Continue → Register
3. `.p8` 파일 다운로드 (**한 번만 받을 수 있습니다**) + **Key ID** 기록, **Team ID** 는 계정 우측 상단
4. Firebase Console → **프로젝트 설정** → **클라우드 메시징** → *Apple 앱 구성* → **APNs 인증 키 업로드** (.p8 + Key ID + Team ID)

> 인증서(.p12) 대신 인증 키(.p8)를 쓰는 이유: 만료가 없고 개발/배포 구분이 없습니다.

## 3. Xcode — Capability

`mobile/ios/App/App.xcworkspace` 를 열고 **App** 타깃 → **Signing & Capabilities**:

- **+ Capability** → **Push Notifications**
- **+ Capability** → **Background Modes** → **Remote notifications** 체크

App ID 에 Push 권한이 자동으로 붙고 프로비저닝 프로파일이 갱신됩니다.

## 4. 빌드

```bash
cd mobile
npm install
npx cap sync ios      # Podfile 갱신 + pod install
npm run ios           # build.sh → cap copy → Xcode 열기
```

> **이 맥에는 CocoaPods 가 없습니다.** 시스템 루비가 2.6 인데 요즘 `ffi` 는 루비 3.0+ 를 요구해
> `gem install cocoapods` 가 실패합니다(`Podfile.lock` 은 1.16.2 로 잠겨 있으니 예전엔 되는 환경이 있었습니다).
> 루비 3.x(rbenv/asdf 등)를 깔고 `gem install cocoapods` 하면 됩니다.
> 그 전까지 Xcode 빌드는 되지 않습니다 — `Podfile` 에 `CapacitorFirebaseMessaging` 은 이미 추가해 뒀습니다.

Archive → Distribute App → App Store Connect → TestFlight 순서는 `APPSTORE.md` 와 같습니다.

## 5. 확인

1. TestFlight 로 받은 앱에서 **관리자 계정으로 로그인**
2. 알림 권한 팝업 → 허용 (거부해도 앱은 그대로 쓸 수 있고, 나중에 iOS 설정에서 켜면 다음 로그인 때 등록됩니다)
3. 다른 기기/브라우저에서 **학생 계정으로 질문 등록**
4. 관리자 폰에 알림이 뜨는지 확인. 안 오면 Cloud Functions 로그에서 `[push]` 를 확인하세요:
   ```bash
   cd functions && npx firebase functions:log --only tokenApi | grep push
   ```

---

## 동작 구조

```
학생 동작 → tokenApi(Cloud Function) → push.js → FCM → APNs → 관리자 폰
                                    └→ notify.js → 뿌리오 → 알림톡(학생·보호자)
```

- 토큰은 `pushTokens/{token}` 문서 하나 = 기기 하나. 문서 id 가 토큰이라 같은 기기가 다시 등록해도 늘어나지 않습니다.
- 이 컬렉션은 `firestore.rules` 에서 **읽기까지 막혀** 있습니다 — 토큰은 그 기기로 알림을 보낼 수 있는 자격증명입니다. 등록·삭제는 `tokenApi` 의 `registerPush`/`unregisterPush` 만 합니다.
- 앱을 지우거나 재설치해 죽은 토큰은 **발송 때 응답을 보고 서버가 바로 지웁니다**. 안 지우면 매번 같은 실패가 쌓여 로그가 쓸모없어집니다.
- 푸시 실패는 절대 본 기능(질문 등록·결제 요청)을 되돌리지 않습니다. `push.js` 는 throw 하지 않습니다.

## 안드로이드

`mobile/android` 는 아직 만들지 않았습니다. 추가할 때는 Firebase Console 에서 Android 앱을 등록하고
`google-services.json` 을 `mobile/android/app/` 에 넣으면 같은 코드가 그대로 돕니다(FCM 이라 서버는 손댈 게 없습니다).
