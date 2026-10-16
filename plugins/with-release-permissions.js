// Copied from breathe v3.1 F2 (its D64), 2026-10-16 P0: preview and production Android builds drop permissions that
// the Expo template and libraries declare but this app never uses, so the Play listing and Data safety show
// only what the app needs. Same mechanism as the sibling apps' with-no-internet.js: a `tools:node="remove"`
// entry also strips the permission from library manifests during the manifest merge. Development builds keep
// everything (they load JavaScript from Metro over the network). Checked with `aapt dump permissions` (P10 here).
const { withAndroidManifest } = require('expo/config-plugins');

const REMOVE = [
  // No network code anywhere in src/ or modules/ (SPEC §10, D18).
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  // Expo template leftovers (dev-menu overlay, system settings) and the pre-Android 13 storage pair: export and
  // backup (P9) go through the share sheet and the system file picker, which need no permission.
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_SETTINGS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  // Push messaging, the Play install referrer and local notifications: this app posts no notification of its own
  // (expo-notifications stays installed but unused, D22); the Android media-session notification needs none of these
  // (media-session notifications are exempt from POST_NOTIFICATIONS, D17).
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'com.google.android.c2dm.permission.RECEIVE',
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
  // Launcher badge permissions (ShortcutBadger in expo-notifications): the app shows no badge. Launcher quick
  // actions use ShortcutManager, which needs no permission.
  'android.permission.READ_APP_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
];

module.exports = function withReleasePermissions(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] ?? 'http://schemas.android.com/tools';
    const kept = (manifest['uses-permission'] ?? []).filter((p) => !REMOVE.includes(p.$['android:name']));
    for (const name of REMOVE) kept.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    manifest['uses-permission'] = kept;
    return mod;
  });
};

module.exports.REMOVED_PERMISSIONS = REMOVE;
