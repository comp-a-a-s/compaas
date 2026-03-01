import { useState } from 'react';

interface CompassRoseLogoProps {
  size?: number;
  inset?: boolean;
}

export default function CompassRoseLogo({ size = 32, inset = true }: CompassRoseLogoProps) {
  const [fallback, setFallback] = useState(false);
  const imageSrc = fallback ? '/compass-rose.svg' : '/logo-final.png';

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: inset ? `${Math.max(10, Math.round(size * 0.35))}px` : '50%',
        display: 'grid',
        placeItems: 'center',
        background: inset
          ? 'radial-gradient(circle at 28% 22%, rgba(160,240,232,0.35), rgba(17,30,45,0.92) 72%)'
          : 'transparent',
        border: inset ? '1px solid color-mix(in srgb, var(--tf-border) 74%, transparent)' : 'none',
      }}
      aria-hidden="true"
    >
      <img
        src={imageSrc}
        alt="COMPaaS logo"
        width={Math.round(size * 0.82)}
        height={Math.round(size * 0.82)}
        style={{ borderRadius: '50%', objectFit: 'contain', display: 'block' }}
        onError={() => setFallback(true)}
        draggable={false}
      />
    </div>
  );
}
