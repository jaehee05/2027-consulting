# 2027 컨설팅 Mobile (Capacitor)

기존 웹앱(`../index.html`) 을 iOS/Android 네이티브 앱으로 래핑하는 Capacitor 프로젝트.

## 빠른 시작 (Mac)

```bash
npm install
./build.sh                # 루트의 웹 자산을 www/ 로 복사
npm run add:ios           # 최초 1회 — ios/ 폴더 생성
npm run add:android       # 최초 1회 — android/ 폴더 생성

npm run ios               # 빌드 + Xcode 오픈
npm run android           # 빌드 + Android Studio 오픈
```

## 구조

```
mobile/
├── package.json            # Capacitor 의존성
├── capacitor.config.ts     # appId, appName, webDir, 플러그인 설정
├── build.sh                # ../index.html 등 → www/ 복사
├── www/                    # (gitignored) 빌드 산출물
├── ios/                    # iOS Xcode 프로젝트 (cap add ios 후 생성)
└── android/                # Android Studio 프로젝트 (cap add android 후 생성)
```

## 자세한 절차

[../APPSTORE.md](../APPSTORE.md) 참고.

## 웹 코드 변경 후 앱 반영

```bash
./build.sh && npx cap sync
npm run ios     # 또는 npm run android
```

Xcode/Android Studio 에서 ▶ 누르면 됨.
