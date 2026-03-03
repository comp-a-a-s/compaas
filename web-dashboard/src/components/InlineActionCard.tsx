import type { GuidanceAction } from '../types';

interface InlineActionCardProps {
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  correlationId?: string;
  actions?: GuidanceAction[];
  onAction?: (action: GuidanceAction) => void;
}

const ACCENT: Record<'info' | 'warning' | 'error', string> = {
  info: 'var(--tf-accent-blue)',
  warning: 'var(--tf-warning)',
  error: 'var(--tf-error)',
};

const BG: Record<'info' | 'warning' | 'error', string> = {
  info: 'color-mix(in srgb, var(--tf-accent-blue) 12%, transparent)',
  warning: 'color-mix(in srgb, var(--tf-warning) 12%, transparent)',
  error: 'color-mix(in srgb, var(--tf-error) 12%, transparent)',
};

export default function InlineActionCard({
  title,
  message,
  severity = 'info',
  correlationId = '',
  actions = [],
  onAction,
}: InlineActionCardProps) {
  const accent = ACCENT[severity];
  const background = BG[severity];
  return (
    <div
      style={{
        border: `1px solid ${accent}`,
        borderRadius: '10px',
        backgroundColor: background,
        padding: '10px 12px',
      }}
    >
      <p style={{ margin: 0, fontSize: '12px', fontWeight: 700, color: accent }}>
        {title}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--tf-text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {message}
      </p>
      {correlationId && (
        <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--tf-text-muted)' }}>
          Correlation: {correlationId}
        </p>
      )}
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' }}>
          {actions.map((action) => (
            <button
              key={`${action.id}-${action.label}`}
              type="button"
              onClick={() => onAction?.(action)}
              style={{
                border: '1px solid var(--tf-border)',
                borderRadius: '8px',
                backgroundColor: 'var(--tf-surface-raised)',
                color: 'var(--tf-text)',
                fontSize: '11px',
                fontWeight: 600,
                padding: '5px 9px',
                cursor: onAction ? 'pointer' : 'default',
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
