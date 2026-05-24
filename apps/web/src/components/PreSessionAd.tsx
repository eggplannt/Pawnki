import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useShowAds } from '@pawnki/shared';

const AD_COUNTDOWN_SECONDS = 5;

interface PreSessionAdProps {
  onComplete: () => void;
}

export function PreSessionAd({ onComplete }: PreSessionAdProps) {
  const showAds = useShowAds();
  const [secondsLeft, setSecondsLeft] = useState(AD_COUNTDOWN_SECONDS);
  const [canSkip, setCanSkip] = useState(false);
  const adRef = useRef<HTMLModElement>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // If user is premium / self-hosted, skip immediately.
  useEffect(() => {
    if (!showAds) onCompleteRef.current();
  }, [showAds]);

  // Push the AdSense slot once the element is mounted.
  useEffect(() => {
    if (!showAds) return;
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch {}
  }, [showAds]);

  // Countdown timer.
  useEffect(() => {
    if (!showAds) return;
    if (secondsLeft <= 0) { setCanSkip(true); return; }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [showAds, secondsLeft]);

  // Keyboard: ESC skips after countdown.
  useEffect(() => {
    if (!showAds) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && canSkip) onCompleteRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAds, canSkip]);

  if (!showAds) return null;

  const clientId = import.meta.env.VITE_ADSENSE_CLIENT_ID as string | undefined;
  const slot = import.meta.env.VITE_ADSENSE_SLOT_PRESESSION as string | undefined;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
      {/* Countdown badge */}
      <div className="absolute top-4 right-4 min-w-[2rem] h-8 flex items-center justify-center rounded-full bg-bg-elevated border border-border text-content-secondary text-sm font-mono tabular-nums px-2">
        {canSkip ? '' : secondsLeft}
      </div>

      {/* Ad unit */}
      <div className="w-full max-w-xl mx-4 bg-bg-elevated rounded-xl overflow-hidden shadow-2xl border border-border">
        <div className="p-1">
          {clientId && slot ? (
            <ins
              ref={adRef}
              className="adsbygoogle"
              style={{ display: 'block' }}
              data-ad-client={clientId}
              data-ad-slot={slot}
              data-ad-format="auto"
              data-full-width-responsive="true"
            />
          ) : (
            // Dev placeholder — visible when AdSense vars are not set.
            <div className="h-64 flex items-center justify-center text-content-muted text-sm border border-dashed border-border rounded-lg">
              Ad placeholder (configure VITE_ADSENSE_CLIENT_ID)
            </div>
          )}
        </div>
      </div>

      {/* Skip button — appears after countdown */}
      <div className="mt-4 flex flex-col items-center gap-2">
        {canSkip ? (
          <button
            onClick={onComplete}
            className="px-6 py-2 rounded-lg bg-accent text-bg-base font-medium hover:bg-accent-hover transition-colors"
          >
            Skip
          </button>
        ) : (
          <p className="text-content-muted text-sm">
            You can skip in {secondsLeft}s
          </p>
        )}

        <Link
          to="/settings#premium"
          className="text-xs text-content-muted hover:text-content-secondary transition-colors"
          onClick={onComplete}
        >
          Remove ads — Go Premium
        </Link>
      </div>
    </div>
  );
}
