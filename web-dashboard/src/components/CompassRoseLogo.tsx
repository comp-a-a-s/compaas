import { useId } from 'react';

interface CompassRoseLogoProps {
  size?: number;
  inset?: boolean;
}

export default function CompassRoseLogo({ size = 32, inset = true }: CompassRoseLogoProps) {
  const gid = useId();
  const gradA = `${gid}-a`;
  const gradB = `${gid}-b`;

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: inset ? `${Math.max(10, Math.round(size * 0.35))}px` : '0',
        display: 'grid',
        placeItems: 'center',
        background: inset
          ? 'radial-gradient(circle at 28% 22%, rgba(160,240,232,0.35), rgba(17,30,45,0.92) 72%)'
          : 'transparent',
        border: inset ? '1px solid color-mix(in srgb, var(--tf-border) 74%, transparent)' : 'none',
      }}
      aria-hidden="true"
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 100 100" fill="none">
        <defs>
          <linearGradient id={gradA} x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--tf-accent)" />
            <stop offset="100%" stopColor="var(--tf-accent-blue)" />
          </linearGradient>
          <linearGradient id={gradB} x1="90" y1="10" x2="10" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--tf-warning)" />
            <stop offset="100%" stopColor="var(--tf-accent-blue)" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="46" stroke="color-mix(in srgb, var(--tf-text) 24%, transparent)" strokeWidth="4" />
        <polygon points="50,8 61,39 92,50 61,61 50,92 39,61 8,50 39,39" fill={`url(#${gradA})`} opacity="0.95" />
        <polygon points="50,20 56,44 80,50 56,56 50,80 44,56 20,50 44,44" fill={`url(#${gradB})`} opacity="0.92" />
        <circle cx="50" cy="50" r="7" fill="var(--tf-bg)" />
      </svg>
    </div>
  );
}
