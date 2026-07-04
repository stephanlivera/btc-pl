import { describe, it, expect } from 'vitest';
import { skeletonTableRows } from '../ui';

describe('skeletonTableRows', () => {
  it('renders the requested number of rows and columns', () => {
    const html = skeletonTableRows(4, 3);
    expect((html.match(/<tr/g) ?? []).length).toBe(3);
    expect((html.match(/<td/g) ?? []).length).toBe(12);
    expect(html).toContain('terminal-skeleton-block');
    expect(html).toContain('terminal-skeleton-row');
  });

  it('right-aligns non-first columns', () => {
    const html = skeletonTableRows(3, 1);
    expect(html).toContain('text-left');
    expect(html).toContain('text-right');
    expect(html).toContain('terminal-skeleton-block--right');
  });
});