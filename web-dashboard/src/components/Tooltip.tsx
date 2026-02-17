import { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const posStyles: Record<string, React.CSSProperties> = {
  top: { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: '6px' },
  bottom: { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: '6px' },
  right: { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: '6px' },
  left: { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: '6px' },
};

export default function Tooltip({ content, children, position = 'top', delay = 400 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = () => { timerRef.current = setTimeout(() => setVisible(true), delay); };
  const hide = () => { clearTimeout(timerRef.current); setVisible(false); };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}
         onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div style={{
          position: 'absolute',
          ...posStyles[position],
          padding: '5px 10px',
          borderRadius: '6px',
          backgroundColor: 'var(--tf-surface-raised)',
          border: '1px solid var(--tf-border)',
          color: 'var(--tf-text-secondary)',
          fontSize: '11px',
          whiteSpace: 'nowrap',
          zIndex: 9999,
          pointerEvents: 'none',
          animation: 'fade-in 0.15s ease-out both',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {content}
        </div>
      )}
    </div>
  );
}
