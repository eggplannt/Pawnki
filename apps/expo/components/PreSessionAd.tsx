import { useCallback } from 'react';
import { useShowAds } from '@pawnki/shared';

// Interstitial ads on Expo use the AdMob interstitial API.
// Import expo-ads-admob if available; fail open on any error.
// To enable: bun add expo-ads-admob in apps/expo, then set
// EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID in apps/expo/.env.local.

let InterstitialAd: any = null;
let AdEventType: any = null;
try {
  const adMob = require('expo-ads-admob');
  InterstitialAd = adMob.InterstitialAd;
  AdEventType = adMob.AdEventType;
} catch {}

const ADMOB_ID = process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID ?? '';

/** Call `show(onComplete)` before navigating into a practice or review session. */
export function usePreSessionAd() {
  const showAds = useShowAds();

  const show = useCallback(
    async (onComplete: () => void) => {
      if (!showAds || !InterstitialAd || !ADMOB_ID) {
        onComplete();
        return;
      }
      try {
        const ad = InterstitialAd.createForAdRequest(ADMOB_ID);
        await new Promise<void>((resolve) => {
          ad.addAdEventListener(AdEventType.CLOSED, resolve);
          ad.addAdEventListener(AdEventType.ERROR, resolve); // fail open
          ad.load();
        });
        await ad.show();
      } catch {
        // Fail open — never block the session on an ad error.
      }
      onComplete();
    },
    [showAds],
  );

  return { show };
}
