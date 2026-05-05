// Ring buffer + auto-instrumentation console + fetch.
// À chaque event Pionne, on attache les N derniers breadcrumbs → on voit ce
// que l'user faisait juste avant le crash (PDF V1.1+).

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
 * Wrap `console.log/info/warn/error` pour pousser des breadcrumbs.
 * Les originaux sont chaînés — l'output dev reste intact.
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
 * Wrap `fetch` pour pousser un breadcrumb par requête (méthode + URL + status + ms).
 * Idéal pour reconstituer "l'app a fait POST /api/order qui a 500 juste avant le crash".
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

// Strip query string + auth bits — on garde juste le path pour ne pas
// fuiter de PII (?token=…, ?email=…) dans les breadcrumbs.
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
