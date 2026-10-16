import type { ConfigContext, ExpoConfig } from 'expo/config';

// One codebase, three installable variants that can sit side by side on a device.
// Select with APP_VARIANT (set by scripts/native.sh and eas.json).
// Identifier prefix is the owner's portfolio rule (Offscan D27); the slug "tune" is provisional until the owner names
// the app (D10) — a rename is one commit (names, ids, schemes here + the i18n app name).
const ID_PREFIX = 'com.plainapps';
const SLUG = 'tune';
const VARIANTS = {
  development: { name: 'Tune Dev', id: `${ID_PREFIX}.${SLUG}.dev`, scheme: `${SLUG}-dev` },
  preview: { name: 'Tune Preview', id: `${ID_PREFIX}.${SLUG}.preview`, scheme: `${SLUG}-preview` },
  production: { name: 'Tune', id: `${ID_PREFIX}.${SLUG}`, scheme: SLUG },
} as const;

type Variant = keyof typeof VARIANTS;

const variant = (process.env.APP_VARIANT ?? 'development') as Variant;
if (!(variant in VARIANTS)) {
  throw new Error(`Unknown APP_VARIANT "${variant}". Use development, preview or production.`);
}
const { name, id, scheme } = VARIANTS[variant];

// Release builds (preview, production) drop Android permissions the app never uses: INTERNET, notifications,
// storage, overlay/settings and launcher badges (list and reasons in the plugin; breathe D64 pattern, D24 here).
// Development builds keep them (they load JavaScript from Metro over the network).
const releasePlugins: ExpoConfig['plugins'] = variant === 'development' ? [] : ['./plugins/with-release-permissions.js'];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name,
  slug: 'tuner-metronome',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme,
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: id,
    // iPhone only, portrait (SPEC §3).
    supportsTablet: false,
    // App Store Connect export compliance: no network code, no custom encryption.
    config: { usesNonExemptEncryption: false },
    icon: './assets/expo.icon',
    infoPlist: {
      UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait'],
    },
  },
  android: {
    package: id,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#208AEF', image: './assets/images/splash-icon.png', imageWidth: 76 }],
    'expo-sqlite',
    'expo-notifications',
    // Dev builds reopen the last Metro server directly, so Maestro can launch them unattended.
    ['expo-dev-client', { launchMode: 'most-recent' }],
    './plugins/with-dev-menu-defaults.js',
    // Xcode 27 / iOS 27 SDK: apps without the UIScene lifecycle trap at launch. SDK 57 opt-in (expo >= 57.0.23,
    // expo-build-properties >= 57.0.20); SDK 58+ has it by default, then remove this line. See docs/DECISIONS.md D9.
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
    ...releasePlugins,
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    appVariant: variant,
  },
});
