import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kr.kjhedu.consulting2027',
  appName: 'KJHEDU',
  webDir: 'www',
  // 로컬 번들 모드 (App Store 심사 통과 명분).
  // 개발 중 라이브 리로드를 쓰려면 server.url 을 임시로 활성화.
  // server: {
  //   url: 'http://192.168.x.x:5500',
  //   cleartext: true,
  // },
  ios: {
    contentInset: 'always',
    backgroundColor: '#ffffff',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: '#ffffff',
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#ffffff',
    },
  },
};

export default config;
