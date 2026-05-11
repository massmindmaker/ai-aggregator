'use client';

import { useRouter } from 'next/navigation';

export function UseInAgentButton({ slug }: { slug: string }) {
  const router = useRouter();

  function handleClick() {
    try {
      localStorage.setItem('aiag_selected_model_slug', slug);
    } catch {
      // ignore localStorage errors (private mode etc.)
    }
    router.push('/agents/new');
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="tma-btn tma-btn--primary"
      style={{ width: '100%', marginTop: 8 }}
    >
      Использовать в агенте
    </button>
  );
}
