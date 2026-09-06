import { describe, it, expect, vi } from 'vitest';
import {
  cn,
  formatDate,
  formatPrice,
  formatNumber,
  slugify,
  truncate,
  getInitials,
  sleep,
  debounce,
  isServer,
  safeJsonParse,
  formatRelativeTime,
} from '../lib/utils';

describe('cn (className merger)', () => {
  it('should merge class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('should handle conditional classes', () => {
    expect(cn('foo', false && 'bar', 'baz')).toBe('foo baz');
  });

  it('should merge tailwind classes correctly', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });
});

describe('formatDate', () => {
  it('should format date correctly', () => {
    const date = new Date('2024-01-15');
    const result = formatDate(date);
    expect(result).toContain('2024');
    expect(result).toContain('15');
  });

  it('should handle string dates', () => {
    const result = formatDate('2024-01-15');
    expect(result).toContain('2024');
  });

  it('should return empty string for null/undefined', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });
});

describe('formatPrice', () => {
  it('should format price in RUB', () => {
    const result = formatPrice(1000);
    expect(result).toContain('1');
    expect(result).toContain('000');
  });

  it('should handle different currencies', () => {
    const result = formatPrice(100, 'USD');
    expect(result).toContain('100');
  });
});

describe('formatNumber', () => {
  it('should format number with locale', () => {
    const result = formatNumber(1000000);
    // Russian locale uses non-breaking space as thousand separator
    expect(result.replace(/\s/g, ' ')).toBe('1 000 000');
  });
});

describe('slugify', () => {
  it('should create slug from text', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('should remove special characters', () => {
    expect(slugify('Hello! World?')).toBe('hello-world');
  });

  it('should handle multiple spaces', () => {
    expect(slugify('Hello   World')).toBe('hello-world');
  });
});

describe('truncate', () => {
  it('should truncate long strings', () => {
    // truncate takes first N characters and adds '...'
    expect(truncate('Hello World', 8)).toBe('Hello Wo...');
  });

  it('should not truncate short strings', () => {
    expect(truncate('Hello', 10)).toBe('Hello');
  });
});

describe('getInitials', () => {
  it('should get initials from full name', () => {
    expect(getInitials('John Doe')).toBe('JD');
  });

  it('should handle single name', () => {
    expect(getInitials('John')).toBe('J');
  });

  it('should limit to 2 characters', () => {
    expect(getInitials('John Michael Doe')).toBe('JM');
  });
});

describe('sleep', () => {
  it('should delay execution', async () => {
    const start = Date.now();
    await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });
});

describe('debounce', () => {
  it('should debounce function calls', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debouncedFn = debounce(fn, 100);

    debouncedFn();
    debouncedFn();
    debouncedFn();

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('isServer', () => {
  it('should be false in jsdom', () => {
    // In jsdom, window is defined
    expect(isServer).toBe(false);
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('should return fallback for invalid JSON', () => {
    expect(safeJsonParse('invalid', { default: true })).toEqual({
      default: true,
    });
  });
});

describe('formatRelativeTime', () => {
  it('should format recent time', () => {
    const now = new Date();
    const result = formatRelativeTime(now);
    expect(result).toBe('только что');
  });

  it('should format minutes ago', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    const result = formatRelativeTime(date);
    expect(result).toContain('минуту');
  });

  it('should format hours ago', () => {
    const date = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const result = formatRelativeTime(date);
    expect(result).toContain('час');
  });
});
