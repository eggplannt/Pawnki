import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useShowAds } from '@pawnki/shared';

const CLIENT = import.meta.env.VITE_ADSENSE_CLIENT_ID as string | undefined;
const SLOT   = import.meta.env.VITE_ADSENSE_SLOT_PRESESSION as string | undefined;

export function BannerAd() {
  const showAds = useShowAds();
  const pushed = useRef(false);

  useEffect(() => {
    if (!showAds || !CLIENT || !SLOT || pushed.current) return;
    pushed.current = true;
    try {
      ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
    } catch {}
  }, [showAds]);

  if (!showAds) return null;

  return (
    <div className="shrink-0 border-t border-border bg-bg-surface">
      <div className="relative">
        {CLIENT && SLOT ? (
          <ins
            className="adsbygoogle"
            style={{ display: 'block' }}
            data-ad-client={CLIENT}
            data-ad-slot={SLOT}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        ) : (
          <div className="h-16 flex items-center justify-center gap-4 px-4">
            <span className="text-content-muted text-xs">Ad placeholder</span>
          </div>
        )}
        <Link
          to="/settings#premium"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-content-muted hover:text-content-secondary transition-colors whitespace-nowrap"
        >
          Remove ads
        </Link>
      </div>
    </div>
  );
}
