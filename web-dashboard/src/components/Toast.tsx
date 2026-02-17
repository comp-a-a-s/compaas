import { createContext, useContext, useState, useCallback, useRef } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

interface ToastContextValue {
  toast: (message: string, type?: ToastItem['type']) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() { return useContext(ToastContext); }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counterRef = useRef(0);

  const toast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = ++counterRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const colorMap: Record<string, string> = {
    info: 'var(--tf-accent-blue)',
    success: 'var(--tf-success)',
    warning: 'var(--tf-warning)',
    error: 'var(--tf-error)',
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{
        position: 'fixed', top: '16px', right: '16px', zIndex: 99999,
        display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            padding: '10px 16px', borderRadius: '8px',
            backgroundColor: 'var(--tf-surface)',
            border: `1px solid ${colorMap[t.type]}`,
            color: 'var(--tf-text)',
            fontSize: '13px',
            animation: 'slide-in-right 0.2s ease-out both',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            pointerEvents: 'auto',
          }}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
