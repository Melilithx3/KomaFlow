import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767.98px)';

/** Mobile layout below 768 px (docs/06-web.md §1.4). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia?.(QUERY);
      m?.addEventListener('change', cb);
      return () => m?.removeEventListener('change', cb);
    },
    () => window.matchMedia?.(QUERY).matches ?? false,
  );
}
