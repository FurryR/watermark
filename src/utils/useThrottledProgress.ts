import { useEffect, useRef } from "react";

/**
 * Coalesces frequent progress updates into a single state update per animation
 * frame, avoiding a full component re-render on every (often >60/s) progress tick.
 */
export function useThrottledProgress(setProgress: (percent: number) => void) {
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const flush = () => {
    rafRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next !== null) {
      setProgress(next);
    }
  };

  const push = (percent: number) => {
    pendingRef.current = Math.max(0, Math.min(100, Math.round(percent)));
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flush);
    }
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return push;
}
