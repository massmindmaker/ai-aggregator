// Тактильный отклик через Telegram WebApp HapticFeedback.
// На десктопе / вне Telegram — тихий no-op (guard'ы внутри).
type Impact = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
type Notify = 'error' | 'success' | 'warning';

function hf(): any {
  return typeof window !== 'undefined'
    ? (window as any).Telegram?.WebApp?.HapticFeedback
    : undefined;
}

export const haptic = {
  impact: (s: Impact = 'light') => {
    try {
      hf()?.impactOccurred(s);
    } catch {}
  },
  notify: (t: Notify) => {
    try {
      hf()?.notificationOccurred(t);
    } catch {}
  },
  select: () => {
    try {
      hf()?.selectionChanged();
    } catch {}
  },
};
