import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  prefersReducedMotion,
  chartAnimationDuration,
  chartUpdateOptions,
} from '../motion';

function stubWindowMatchMedia(matches: boolean) {
  vi.stubGlobal('window', {
    matchMedia: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

describe('motion helpers', () => {
  beforeEach(() => {
    stubWindowMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chartAnimationDuration returns default when motion is allowed', () => {
    expect(chartAnimationDuration(300)).toBe(300);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('chartAnimationDuration returns 0 when reduced motion is preferred', () => {
    stubWindowMatchMedia(true);
    expect(chartAnimationDuration(300)).toBe(0);
    expect(prefersReducedMotion()).toBe(true);
  });

  it('chartUpdateOptions scales duration with reduced motion', () => {
    stubWindowMatchMedia(true);
    expect(chartUpdateOptions(true)).toEqual({ duration: 0, easing: 'easeOutCubic' });
    expect(chartUpdateOptions(false)).toEqual({ duration: 0, easing: 'easeOutQuart' });
  });

  it('chartUpdateOptions preserves easing when motion is allowed', () => {
    expect(chartUpdateOptions(true)).toEqual({ duration: 380, easing: 'easeOutCubic' });
    expect(chartUpdateOptions(false)).toEqual({ duration: 220, easing: 'easeOutQuart' });
  });
});