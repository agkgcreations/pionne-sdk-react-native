// Wrap setTimeout / setInterval / requestAnimationFrame to capture sync
// exceptions thrown from their callback. Standard approach — handles the
// typical `setTimeout(() => { throw ... }, 50)` case that
// `ErrorUtils.setGlobalHandler` doesn't always catch on Hermes in dev.

let installed = false;

export function wrapTimers(reportFn: (err: unknown) => void): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    requestAnimationFrame?: (cb: (t: number) => void) => number;
  };

  const _setTimeout = g.setTimeout.bind(globalThis);
  const _setInterval = g.setInterval.bind(globalThis);
  const _raf = g.requestAnimationFrame?.bind(globalThis);

  g.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const wrapped = (...args: unknown[]) => {
      try {
        return cb(...args);
      } catch (e) {
        reportFn(e);
        throw e;
      }
    };
    return _setTimeout(wrapped as Parameters<typeof setTimeout>[0], ms as number, ...rest);
  }) as typeof setTimeout;

  g.setInterval = ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const wrapped = (...args: unknown[]) => {
      try {
        return cb(...args);
      } catch (e) {
        reportFn(e);
        throw e;
      }
    };
    return _setInterval(wrapped as Parameters<typeof setInterval>[0], ms as number, ...rest);
  }) as typeof setInterval;

  if (_raf) {
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      const wrapped = (t: number) => {
        try {
          return cb(t);
        } catch (e) {
          reportFn(e);
          throw e;
        }
      };
      return _raf(wrapped);
    };
  }
}
