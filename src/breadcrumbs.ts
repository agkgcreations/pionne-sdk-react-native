// Ring buffer + console + fetch auto-instrumentation.
// On every Pionne event we attach the last N breadcrumbs → you see what the
// user was doing right before the crash.

export type Breadcrumb = {
  ts: number;
  category: 'console' | 'http' | 'navigation' | 'ui' | 'custom';
  level?: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

const MAX_BREADCRUMBS = 25;
const buffer: Breadcrumb[] = [];

export function addBreadcrumb(b: Omit<Breadcrumb, 'ts'> & { ts?: number }): void {
  buffer.push({
    ts: b.ts ?? Date.now(),
    category: b.category,
    level: b.level,
    message: b.message,
    data: b.data,
  });
  if (buffer.length > MAX_BREADCRUMBS) {
    buffer.splice(0, buffer.length - MAX_BREADCRUMBS);
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  return buffer.slice();
}

export function clearBreadcrumbs(): void {
  buffer.length = 0;
}

let consoleWrapped = false;

/**
 * Wrap `console.log/info/warn/error` to push breadcrumbs.
 * The originals are chained — dev output stays intact.
 */
export function wrapConsole(): void {
  if (consoleWrapped) return;
  consoleWrapped = true;

  const levels: Array<{ method: 'log' | 'info' | 'warn' | 'error'; level: Breadcrumb['level'] }> = [
    { method: 'log', level: 'debug' },
    { method: 'info', level: 'info' },
    { method: 'warn', level: 'warning' },
    { method: 'error', level: 'error' },
  ];

  for (const { method, level } of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      try {
        addBreadcrumb({
          category: 'console',
          level,
          message: args
            .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
            .join(' ')
            .slice(0, 500),
        });
      } catch {
        // never crash the host
      }
      original(...args);
    };
  }
}

let fetchWrapped = false;

/**
 * Wrap `fetch` to push one breadcrumb per request (method + URL + status + ms).
 * Useful for reconstructing "the app did POST /api/order that 500'd right before the crash".
 */
export function wrapFetch(): void {
  if (fetchWrapped) return;
  fetchWrapped = true;

  const g = globalThis as unknown as { fetch: typeof fetch };
  const original = g.fetch.bind(globalThis);

  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = Date.now();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input
      ? (input as Request).method
      : 'GET')).toUpperCase();

    try {
      const res = await original(input, init);
      addBreadcrumb({
        category: 'http',
        level: res.ok ? 'info' : 'warning',
        message: `${method} ${stripUrl(url)} → ${res.status}`,
        data: { method, url: stripUrl(url), status: res.status, duration_ms: Date.now() - start },
      });
      return res;
    } catch (err) {
      addBreadcrumb({
        category: 'http',
        level: 'error',
        message: `${method} ${stripUrl(url)} → network error`,
        data: { method, url: stripUrl(url), duration_ms: Date.now() - start },
      });
      throw err;
    }
  }) as typeof fetch;
}

// Strip query string + auth bits — keep just the path so we don't leak
// PII (?token=…, ?email=…) in the breadcrumbs.
function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return '[Unserializable]';
  }
}
