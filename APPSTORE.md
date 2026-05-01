# 2027 컨설팅 — App Store / Play Store 배포 가이드

Capacitor 로 기존 웹앱을 iOS/Android 네이티브 앱으로 래핑해서 스토어에 올리는 절차입니다.

이 문서는 **Mac + Apple Developer 계정 + Google Play Console** 보유 가정으로 작성됨.

---

## 0. 사전 준비

### 필수
- **Mac** (iOS 빌드는 Xcode 가 macOS 에서만 동작)
- **Xcode 16+** (App Store) → Mac App Store 에서 무료 설치
- **Android Studio** (Android 빌드용) → https://developer.android.com/studio
- **Node.js 20+** (`brew install node@20`)
- **CocoaPods** (`sudo gem install cocoapods` 또는 `brew install cocoapods`)
- **Apple Developer Program** $99/년 가입 완료
- **Google Play Console** $25 일회성 가입 완료

### 권장
- **iPhone 실기기** (시뮬레이터로도 가능하나 실기기 테스트 권장)
- **Android 실기기 또는 에뮬레이터**

---

## 1. 최초 셋업 (Mac에서 한 번만)

```bash
# 저장소 clone + 모바일 폴더 진입
git clone https://github.com/jaehee05/2027-consulting.git
cd 2027-consulting/mobile

# 의존성 설치
npm install

# 웹 자산을 www/ 로 빌드
./build.sh

# iOS / Android 네이티브 프로젝트 생성 (최초 1회)
npm run add:ios
npm run add:android
```

`mobile/ios/` 와 `mobile/android/` 폴더가 자동 생성됩니다. 이 폴더들은 git 에 커밋해서 협업/CI 가 가능하게 유지하시면 됩니다.

```bash
cd ..
git add mobile/ios mobile/android
git commit -m "Add iOS/Android native projects (Capacitor)"
git push
```

---

## 2. iOS 빌드 (Xcode)

### Xcode 열기
```bash
cd mobile
npm run ios
```

자동으로 Xcode 가 열립니다 (`mobile/ios/App/App.xcworkspace` 가 열려야 합니다 — `.xcodeproj` 가 아님).

### Xcode 에서 설정
1. 좌측 트리에서 **App** 프로젝트 선택 → **Signing & Capabilities** 탭
2. **Team** 드롭다운에서 본인 Apple Developer 팀 선택
3. **Bundle Identifier** 확인: `kr.kjhedu.consulting2027` (capacitor.config.ts 의 appId 와 동일)
4. (선택) **Capabilities** 추가:
   - Push Notifications (추후 푸시 알림 추가 시)
   - Sign in with Apple (생체인증 미사용 시 우회 옵션으로 활용 가능)

### 시뮬레이터 실행
- 상단 디바이스 선택 드롭다운에서 iPhone 16 등 선택 → ▶ 버튼

### 실기기 실행
- iPhone USB 연결 → 디바이스 드롭다운에 본인 폰 표시됨 → 선택 → ▶
- 첫 실행 시 폰의 **설정 → 일반 → VPN 및 기기 관리** 에서 본인 개발자 계정 신뢰 처리

### App Store 업로드 (Archive)
1. 디바이스 드롭다운에서 **Any iOS Device (arm64)** 선택
2. 메뉴: **Product → Archive**
3. 빌드 완료 후 **Organizer** 창 자동 오픈
4. **Distribute App → App Store Connect → Upload**
5. 업로드 완료까지 5~15분 소요

---

## 3. App Store Connect 메타데이터

업로드 후 [App Store Connect](https://appstoreconnect.apple.com) 에서:

### 신규 앱 생성 (최초 1회)
1. **My Apps → +** 버튼 → **New App**
2. **Platforms**: iOS
3. **Name**: 2027 컨설팅
4. **Primary Language**: Korean
5. **Bundle ID**: `kr.kjhedu.consulting2027` 선택
6. **SKU**: `consulting2027-ios` (내부 식별자, 임의)

### 앱 정보 입력
- **카테고리**: Education (1차) / Productivity (2차)
- **나이 등급**: 12+ (사용자 생성 콘텐츠 가능)
- **개인정보처리방침 URL**: 필수 (학생 데이터 수집)
- **앱 아이콘**: 1024×1024px PNG (알파 채널 없이)
- **스크린샷**: iPhone 6.7" + 6.5" + 5.5" 각 최소 3장
- **설명**: 한국어
- **키워드**: 컨설팅,상담,예약,학원,모의평가,입시,컨설턴트,학생관리

### 심사용 메모 (Review Information)
4.2 조항(웹 래퍼 거절) 대비 권장 메모:

> 본 앱은 학원 컨설팅 예약·관리 전용 도구로, 다음 네이티브 기능을 제공합니다:
> - 푸시 알림을 통한 예약 변경/취소 즉시 통지 (예정)
> - 학생/관리자별 차별화된 모바일 최적 UI
> - 카카오 알림톡 연동 자동 발송 (학원 운영 워크플로우 통합)
> - 오프라인 기본 정보 캐싱
>
> 데모 계정:
> - ID: `apple-review`
> - PW: (제출 직전 임시 계정 발급, 메모에 포함)

### 빌드 선택 + 심사 제출
1. **TestFlight** 탭에서 업로드된 빌드 표시 확인 (15~30분 소요)
2. **App Store** 탭 → 버전 정보 입력 → **빌드 추가** → 업로드한 빌드 선택
3. **심사 제출**

평균 심사 기간: **24~72시간**. 4.2 조항으로 거절될 경우 Reply 에 위 네이티브 기능 명세 강조.

---

## 4. Android 빌드 (Android Studio)

```bash
cd mobile
npm run android
```

### Android Studio 에서 설정
1. **Build → Generate Signed Bundle / APK** → **Android App Bundle (AAB)**
2. **Create new keystore** (최초 1회) — 안전한 곳에 백업 필수
3. **release** 빌드 변형 선택 → **Finish**
4. 산출물: `mobile/android/app/build/outputs/bundle/release/app-release.aab`

### Play Console 업로드
1. [Play Console](https://play.google.com/console) → **앱 만들기**
2. 앱 이름: 2027 컨설팅 / 기본 언어: 한국어
3. **프로덕션 → 새 버전 만들기** → AAB 업로드
4. 콘텐츠 등급, 데이터 보안, 대상 연령, 개인정보처리방침 작성
5. **검토 시작 → 출시**

평균 심사 기간: **2~7일** (Apple 보다 까다롭지 않음).

---

## 5. 업데이트 워크플로우 (스토어 출시 후)

웹 코드(`index.html`) 수정 → 스토어에도 반영하고 싶을 때:

```bash
cd mobile
./build.sh           # 최신 index.html 을 www/ 로 복사
npx cap sync         # iOS/Android 네이티브 프로젝트로 동기화
npm run ios          # iOS 빌드 및 Archive 진행
# 또는
npm run android      # Android 빌드
```

**버전 번호 올리기**:
- iOS: Xcode → App 타겟 → **General → Version** (예: 1.0.0 → 1.0.1) + **Build** (1 → 2)
- Android: `mobile/android/app/build.gradle` → `versionCode` (정수 +1) + `versionName` (1.0.1)

> 작은 텍스트/UX 수정만 있을 경우 Capacitor Live Updates 같은 OTA 도구를 도입하면 스토어 재심사 없이 업데이트 가능. 추후 검토.

---

## 6. 푸시 알림 추가 (Phase 2 — 권장)

App Store 4.2 조항(웹 래퍼) 대비 가장 강한 명분.

### 설치
```bash
cd mobile
npm install @capacitor/push-notifications firebase
npx cap sync
```

### iOS 추가 설정
- Xcode → **Signing & Capabilities** → **+ Capability** → **Push Notifications** 추가
- **+ Capability** → **Background Modes** → **Remote notifications** 체크
- Apple Developer 사이트 → **Certificates, Identifiers & Profiles** → **Keys** → APNs Auth Key 발급 (.p8) → Firebase 콘솔에 업로드

### 코드 통합 예시
`index.html` 또는 별도 `app-native.js` 에 추가:

```javascript
import { PushNotifications } from '@capacitor/push-notifications';

if (window.Capacitor?.isNativePlatform?.()) {
  PushNotifications.requestPermissions().then(p => {
    if (p.receive === 'granted') PushNotifications.register();
  });
  PushNotifications.addListener('registration', token => {
    // 학생 문서에 fcmToken 저장
    db.collection('students').doc(S.studentDocId).update({ fcmToken: token.value });
  });
  PushNotifications.addListener('pushNotificationReceived', n => {
    // 앱 실행 중 수신 처리
  });
}
```

Cloud Function 측에서는 기존 알림톡 발송과 동일한 트리거에서 FCM 도 함께 호출하면 됨.

---

## 7. 자주 거절되는 사유 & 대응

### Apple
- **4.2 (웹 래퍼)**: 네이티브 기능 추가 + 심사 메모 강조
- **5.1.1 (개인정보)**: 개인정보처리방침 URL 누락 금지, 데이터 수집 항목 정직하게 신고
- **2.1 (앱 완성도)**: 데모 계정 정확히 동작해야 함, 빈 화면 / 크래시 없어야

### Google
- **선언 누락**: 데이터 보안 섹션의 학생 정보 수집 신고 필수
- **콘텐츠 등급**: 사용자 생성 콘텐츠(질문/사유 입력) 있으니 12+ 권장
- **개인정보처리방침**: 활성 URL 필수

---

## 8. 다음에 도와드릴 작업

- ✅ Capacitor 셋업 (이 문서)
- ⏭️ 푸시 알림 코드 통합 (Phase 2)
- ⏭️ 앱 아이콘 / 스플래시 자동 생성 스크립트 (`@capacitor/assets`)
- ⏭️ 개인정보처리방침 페이지 작성 (HTML 한 페이지)
- ⏭️ 심사용 데모 계정 생성 흐름
- ⏭️ App Store Connect API 토큰 기반 자동 업로드 (Fastlane)

필요한 것부터 알려주시면 이어서 작업하겠습니다.
