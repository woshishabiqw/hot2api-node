import { useState, useEffect, useRef } from 'react';
import api from '../lib/api';

export default function Banner() {
  const [banner, setBanner] = useState({ enabled: false, text: '' });
  const bannerRef = useRef(null);
  const trackRef = useRef(null);
  const gap = 80;
  const SCROLL_SPEED_PX_PER_SEC = 80;

  // Fetch banner settings
  useEffect(() => {
    api.get('/user/settings').then(res => {
      if (res.data.banner_enabled && res.data.banner_text) {
        setBanner({ enabled: true, text: res.data.banner_text });
      }
    }).catch(() => {});
  }, []);

  // Smooth infinite scroll with requestAnimationFrame
  useEffect(() => {
    if (!banner.enabled) return;

    const track = trackRef.current;
    const container = bannerRef.current;
    if (!track || !container) return;

    let rafId;
    let startTime = performance.now();
    let groupWidth = 0;
    let isSetup = false;

    const setup = () => {
      const trackRect = track.getBoundingClientRect();
      // track contains two identical groups; measure the half width precisely
      groupWidth = trackRect.width / 2;
      if (groupWidth <= 0) return false;
      isSetup = true;
      return true;
    };

    const animate = (now) => {
      if (!isSetup) {
        if (setup()) {
          startTime = now;
        }
        rafId = requestAnimationFrame(animate);
        return;
      }

      const elapsed = (now - startTime) / 1000;
      const distance = elapsed * SCROLL_SPEED_PX_PER_SEC;
      const pos = -(distance % groupWidth);
      track.style.transform = `translate3d(${pos}px, 0, 0)`;
      rafId = requestAnimationFrame(animate);
    };

    // Delay to let DOM settle before measuring
    const startTimer = setTimeout(() => {
      rafId = requestAnimationFrame(animate);
    }, 150);

    const onResize = () => {
      setup();
    };
    window.addEventListener('resize', onResize);

    return () => {
      clearTimeout(startTimer);
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    };
  }, [banner.enabled, banner.text]);

  if (!banner.enabled) return null;

  // Compute copies needed to fill viewport × 2
  // Use a safe over-estimate; actual loop width is measured from DOM
  const containerW = bannerRef.current?.offsetWidth || 1200;
  // Estimate item width: average Chinese char ~16px + English ~8px at text-sm
  const charWidth = /[\u4e00-\u9fff]/.test(banner.text) ? 16 : 8;
  const itemWEstimate = Math.max(banner.text.length * charWidth, 200);
  const copiesPerGroup = Math.max(3, Math.ceil((containerW * 2.5) / (itemWEstimate + gap)) + 1);

  const items = Array.from({ length: copiesPerGroup }, (_, i) => (
    <span key={`a-${i}`} className="text-sm font-medium text-primary/80 tracking-wide shrink-0">
      {banner.text}
    </span>
  ));

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
        ref={trackRef}
        className="flex whitespace-nowrap py-2 will-change-transform"
        style={{ width: 'max-content', gap: `${gap}px` }}
      >
        {items}
        {items.map((_, i) => (
          <span key={`b-${i}`} className="text-sm font-medium text-primary/80 tracking-wide shrink-0" aria-hidden="true">
            {banner.text}
          </span>
        ))}
      </div>
    </div>
  );
}
