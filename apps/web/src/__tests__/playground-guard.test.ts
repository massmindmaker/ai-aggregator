import { describe, it, expect } from 'vitest';
import { playgroundAllowed } from '@/app/api/playground/run/guard';

describe('playground guard', () => {
  it('🔴 неопределённый IP НЕ пропускает лимит (был обход)', () => {
    expect(playgroundAllowed({ ip: undefined, used: 0, limit: 5 })).toBe(false);
  });

  it('в пределах лимита — можно', () => {
    expect(playgroundAllowed({ ip: '1.2.3.4', used: 2, limit: 5 })).toBe(true);
  });

  it('лимит исчерпан — нельзя', () => {
    expect(playgroundAllowed({ ip: '1.2.3.4', used: 5, limit: 5 })).toBe(false);
  });
});
