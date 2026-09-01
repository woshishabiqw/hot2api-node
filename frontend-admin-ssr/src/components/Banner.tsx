import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../lib/api';

export default function Banner() {
  const [banner, setBanner] = useState({ enabled: false, text: '' });
  const bannerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(2);
  const [bannerDuration, setBannerDuration] = useState(30);
  const gap = 80;
  const SCROLL_SPEED_PX_PER_SEC = 80;

  useEffect(() => {
    api.get('/user/settings').then(res => {
      if (res.data.banner_enabled && res.data.banner_text) {
        setBanner({ enabled: true, text: res.data.banner_text });
      }
    }).catch(() => {});
  }, []);

  const recalcCopies = useCallback(() => {
    if (!bannerRef.current || !contentRef.current) return;
    const containerW = bannerRef.current.offsetWidth;
    const itemW = contentRef.current.offsetWidth;
    if (itemW === 0) return;
    const needed = Math.max(2, Math.ceil((containerW * 2) / itemW) + 1);
    setCopies(needed);
    const duration = (itemW + gap) / SCROLL_SPEED_PX_PER_SEC;
    setBannerDuration(Math.max(duration, 5));
  }, []);

  useEffect(() => {
    if (!banner.enabled) return;
    const timer = setTimeout(recalcCopies, 50);
    window.addEventListener('resize', recalcCopies);
    return () => { clearTimeout(timer); window.removeEventListener('resize', recalcCopies); };
  }, [banner.enabled, banner.text, recalcCopies]);

  if (!banner.enabled) return null;

  return (
    <div
      ref={bannerRef}
      className="relative overflow-hidden border-b bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5"
      style={{
        maskImage: 'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
      }}
    >
      <div
        className="flex whitespace-nowrap py-2"
        style={{ width: 'max-content', gap: `${gap}px`, animation: `banner-scroll ${bannerDuration}s linear infinite` }}
      >
        <span ref={contentRef} className="text-sm font-medium text-primary/80 tracking-wide shrink-0">{banner.text}</span>
        {Array.from({ length: copies - 1 }).map((_, i) => (
          <span key={i} className="text-sm font-medium text-primary/80 tracking-wide shrink-0">{banner.text}</span>
        ))}
      </div>
      <style>{`
        @keyframes banner-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(calc(-100% / ${copies})); }
        }
      `}</style>
    </div>
  );
}
