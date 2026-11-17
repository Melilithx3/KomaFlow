import { useSyncExternalStore } from 'react';

let online = true;
const listeners = new Set<() => void>();

export function setOnline(v: boolean) {
  if (v === online) return;
  online = v;
  for (const l of listeners) l();
}

/** True while the last request reached the server. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => online,
  );
}
