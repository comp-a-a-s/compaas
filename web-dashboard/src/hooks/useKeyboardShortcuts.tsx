import { useEffect, useState, useCallback } from 'react';

export function useKeyboardShortcuts(shortcuts: Record<string, () => void>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const fn = shortcuts[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts]);
}

export function useShortcutsPanel() {
  const [visible, setVisible] = useState(false);

  const toggle = useCallback(() => setVisible(v => !v), []);
  const hide = useCallback(() => setVisible(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '?') { e.preventDefault(); setVisible(v => !v); }
      if (e.key === 'Escape') setVisible(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return { visible, toggle, hide };
}

const SHORTCUTS = [
  { key: '1', desc: 'Overview' },
  { key: '2', desc: 'Agents' },
  { key: '3', desc: 'Projects' },
  { key: '4', desc: 'Event Log' },
  { key: '5', desc: 'Settings' },
  { key: 'C', desc: 'Toggle CEO Chat' },
  { key: '?', desc: 'Show Shortcuts' },
  { key: 'Esc', desc: 'Close Panels' },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99998,
      backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        backgroundColor: 'var(--tf-surface)',
        border: '1px solid var(--tf-border)',
        borderRadius: '12px',
        padding: '24px',
        minWidth: '300px',
        animation: 'slide-up 0.2s ease-out both',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tf-text)', marginBottom: '16px' }}>
          Keyboard Shortcuts
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {SHORTCUTS.map(s => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px' }}>
              <span style={{ fontSize: '13px', color: 'var(--tf-text-secondary)' }}>{s.desc}</span>
              <kbd style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
                backgroundColor: 'var(--tf-surface-raised)',
                border: '1px solid var(--tf-border)',
                color: 'var(--tf-text-muted)',
                fontFamily: 'monospace',
              }}>{s.key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
