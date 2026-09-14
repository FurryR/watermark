/**
 * Coalesces frequent progress updates into a single invocation per animation
 * frame, avoiding a full component re-render on every (often >60/s) progress tick.
 * The latest value wins; intermediate ticks are dropped.
 */
export function throttleProgressUpdates(apply: (value: number) => void) {
  let rafHandle: number | null = null;
  let pending: number | null = null;

  const flush = () => {
    rafHandle = null;
    const next = pending;
    pending = null;
    if (next !== null) {
      apply(next);
    }
  };

  const push = (value: number) => {
    pending = value;
    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(flush);
    }
  };

  const cancel = () => {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    pending = null;
  };

  return { push, cancel };
}
