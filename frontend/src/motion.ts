/** Motion helpers — respects prefers-reduced-motion for all animations. */

let reducedMotion = false;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function chartAnimationDuration(defaultMs: number): number {
  return prefersReducedMotion() ? 0 : defaultMs;
}

export function chartUpdateOptions(isRangeChange: boolean): { duration: number; easing: string } {
  const base = isRangeChange ? 380 : 220;
  return {
    duration: chartAnimationDuration(base),
    easing: isRangeChange ? 'easeOutCubic' : 'easeOutQuart',
  };
}

function isNarrowViewport(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}

function initStickyHeaderFade(): void {
  const header = document.querySelector<HTMLElement>('.terminal-header');
  if (!header) return;

  if (isNarrowViewport()) return;

  header.classList.add('terminal-header--sticky');

  const onScroll = () => {
    const scrollY = window.scrollY;
    const bgOpacity = Math.max(0.12, 0.42 - scrollY * 0.0009);
    const scrollFade = Math.min(1, scrollY / 140);
    header.style.setProperty('--header-bg-opacity', String(bgOpacity));
    header.style.setProperty('--header-scroll-fade', String(scrollFade));
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function initRevealInView(): void {
  const targets = document.querySelectorAll<HTMLElement>('.terminal-reveal-in-view');
  if (!targets.length) return;

  if (reducedMotion || !('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('terminal-reveal-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('terminal-reveal-visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.06, rootMargin: '0px 0px -32px 0px' },
  );

  targets.forEach(el => observer.observe(el));
}

/** Staggered reveal: header → ticker → main chart shell (~80ms apart). */
export function revealStaggerSequence(): void {
  const selectors = [
    '.terminal-reveal-stagger-1',
    '.terminal-reveal-stagger-2',
    '.terminal-reveal-stagger-3',
  ];

  if (reducedMotion) {
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.classList.add('terminal-reveal-visible'));
    });
    return;
  }

  selectors.forEach((sel, index) => {
    window.setTimeout(() => {
      document.querySelectorAll(sel).forEach(el => el.classList.add('terminal-reveal-visible'));
    }, index * 80);
  });
}

export function initMotion(): void {
  reducedMotion = prefersReducedMotion();
  if (reducedMotion) {
    document.documentElement.classList.add('terminal-reduced-motion');
  }

  if (!reducedMotion) {
    initStickyHeaderFade();
  }

  initRevealInView();
}