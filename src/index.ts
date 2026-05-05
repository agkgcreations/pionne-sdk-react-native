import {
  addBreadcrumb as _addBreadcrumb,
  type Breadcrumb,
  getBreadcrumbs,
  wrapConsole,
  wrapFetch,
} from './breadcrumbs';
import { gatherStaticContext } from './context';
import { PionneErrorBoundary } from './error-boundary';
import { captureScreenshot, setRootRef as _setRootRef } from './screenshot';
import { DEFAULT_PATTERNS, scrubDeep, type ScrubPattern } from './scrubber';
import { wrapTimers } from './timers';
import type {
  Level,
  Mechanism,
  MechanismType,
  PionneEvent,
  PionneOptions,
} from './types';

export { PionneErrorBoundary };
export type { Breadcrumb };

export type {
  Level,
  Mechanism,
  MechanismType,
  PionneEvent,
  PionneOptions,
};

const DEFAULT_ENDPOINT = 'https://pionne.agkgcreations.fr/api/ingest';
const DEFAULT_MAX_STACK = 50;

type ResolvedConfig = Required<
  Omit<
    PionneOptions,
    | 'beforeSend'
    | 'userIdAnon'
    | 'tags'
    | 'release'
    | 'appId'
    | 'scrubPii'
    | 'breadcrumbs'
  >
> & {
  beforeSend?: PionneOptions['beforeSend'];
  userIdAnon?: string;
  tags?: Record<string, string>;
  release?: string;
  appId?: string;
  /** Patterns finaux résolus à partir de scrubPii (booleen ou tableau). */
  scrubPatterns?: ScrubPattern[];
};

let config: ResolvedConfig | null = null;
let staticContext: Partial<PionneEvent> = {};
let originalErrorHandler: ((err: Error, isFatal?: boolean) => void) | null = null;

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

function parseStack(error: Error, max: number): string[] {
  if (!error.stack) return [];
  return error.stack.split('\n').slice(0, max).map((s) => s.trim()).filter(Boolean);
}

function buildEvent(
  err: unknown,
  level: Level,
  mechanism: MechanismType,
  handled: boolean,
  extra?: Partial<PionneEvent>,
): PionneEvent | null {
  if (!config || !config.enabled) return null;

  // Sample rate: drop aléatoire avant tout autre traitement.
  if (config.sampleRate < 1 && Math.random() >= config.sampleRate) {
    return null;
  }

  const e = err instanceof Error ? err : new Error(String(err));
  let event: PionneEvent = {
    // Static device/app/OTA/runtime context first (lowest priority).
    ...staticContext,
    exception_type: e.name || 'Error',
    message: e.message || null,
    stack: parseStack(e, config.maxStackFrames),
    level,
    release: config.release,
    environment: config.environment,
    app_id: config.appId ?? staticContext.app_id,
    user_id_anon: config.userIdAnon,
    tags: config.tags,
    mechanism: { type: mechanism, handled },
    ...extra,
  };

  // Attache les N derniers breadcrumbs.
  const crumbs = getBreadcrumbs();
  if (crumbs.length) {
    event.breadcrumbs = crumbs;
  }

  // PII scrubbing — appliqué APRÈS la construction et AVANT beforeSend, pour
  // que le user puisse encore inspecter l'event nettoyé dans son hook.
  if (config.scrubPatterns) {
    event = scrubDeep(event, config.scrubPatterns) as PionneEvent;
  }

  if (config.beforeSend) {
    const result = config.beforeSend(event);
    if (!result) return null;
    return result;
  }
  return event;
}

function send(event: PionneEvent): void {
  if (!config) return;
  // Si captureScreenshot activé, on l'attache de manière async juste avant
  // l'envoi. La signature publique reste sync (fire-and-forget).
  if (config.captureScreenshot) {
    void (async () => {
      try {
        const dataUri = await captureScreenshot(config!.screenshotQuality);
        if (dataUri) event = { ...event, screenshot: dataUri };
      } catch {
        // best-effort
      }
      doSend(event);
    })();
    return;
  }
  doSend(event);
}

function doSend(event: PionneEvent): void {
  if (!config) return;
  if (isDev()) {
    // eslint-disable-next-line no-console
    console.log('[Pionne] sending', event.exception_type, '→', config.endpoint);
  }
  // fetch is part of the React Native global polyfill, so no import needed.
  fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pionne-Token': config.token,
    },
    body: JSON.stringify(event),
  })
    .then((res) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.log('[Pionne] response', res.status);
      }
    })
    .catch((e) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn('[Pionne] send failed', e);
      }
    });
}

function installGlobalErrorHandler(): void {
  // ErrorUtils is a React Native global — we type it loosely to avoid pulling
  // RN types into this isolated SDK package.
  const eu = (globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler: () => (err: Error, isFatal?: boolean) => void;
      setGlobalHandler: (h: (err: Error, isFatal?: boolean) => void) => void;
    };
  }).ErrorUtils;
  if (!eu) return;
  originalErrorHandler = eu.getGlobalHandler();
  eu.setGlobalHandler((err, isFatal) => {
    const event = buildEvent(err, isFatal ? 'fatal' : 'error', 'onerror', false);
    if (event) send(event);
    originalErrorHandler?.(err, isFatal);
  });
}

function installPromiseRejectionHandler(): void {
  // Hermes ships a built-in rejection tracker; we hook into it if available.
  const hermes = (globalThis as unknown as {
    HermesInternal?: {
      enablePromiseRejectionTracker?: (opts: {
        allRejections: boolean;
        onUnhandled: (id: number, reason: unknown) => void;
        onHandled?: (id: number) => void;
      }) => void;
    };
  }).HermesInternal;
  if (hermes?.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, reason) => {
        const event = buildEvent(reason, 'error', 'onunhandledrejection', false);
        if (event) send(event);
      },
    });
  }
  // JSC / older RN: rely on the user wiring `process.on('unhandledRejection', ...)`
  // or calling Pionne.captureException manually inside their .catch blocks.
}

export const Pionne = {
  /**
   * Initialise the SDK. Call this once, as early as possible (App.tsx top-level).
   */
  init(options: PionneOptions): void {
    if (!options?.token || !options.token.startsWith('pio_live_')) {
      // Don't throw — we never want to crash the host. Log loudly in dev only.
      if (isDev()) {
        console.warn('[Pionne] Missing or invalid token (must start with pio_live_).');
      }
      return;
    }

    const autoContext = options.autoContext ?? true;
    staticContext = autoContext ? gatherStaticContext() : {};

    config = {
      token: options.token,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      release: options.release ?? staticContext.app_version,
      environment: options.environment ?? (isDev() ? 'development' : 'production'),
      enabled: options.enabled ?? true,
      captureUncaughtErrors: options.captureUncaughtErrors ?? true,
      captureUnhandledRejections: options.captureUnhandledRejections ?? true,
      autoContext,
      beforeSend: options.beforeSend,
      userIdAnon: options.userIdAnon,
      tags: options.tags,
      maxStackFrames: options.maxStackFrames ?? DEFAULT_MAX_STACK,
      captureScreenshot: options.captureScreenshot ?? false,
      screenshotQuality: options.screenshotQuality ?? 0.5,
      // Bundle ID — option > auto via expo-application > undefined.
      appId: options.appId ?? staticContext.app_id,
      // Sample rate clamp [0, 1].
      sampleRate: Math.max(0, Math.min(1, options.sampleRate ?? 1)),
      // PII scrubbing : true => défauts, array => défauts + custom, false => skip.
      scrubPatterns:
        options.scrubPii === false
          ? undefined
          : Array.isArray(options.scrubPii)
            ? [...DEFAULT_PATTERNS, ...options.scrubPii]
            : DEFAULT_PATTERNS,
    };

    if (config.captureUncaughtErrors) {
      installGlobalErrorHandler();
      // Wrap timers so `setTimeout(() => { throw … })` is reported even when
      // ErrorUtils.setGlobalHandler is bypassed by HMR or Hermes-in-dev.
      wrapTimers((err) => {
        const event = buildEvent(err, 'error', 'onerror', false);
        if (event) send(event);
      });
    }
    if (config.captureUnhandledRejections) installPromiseRejectionHandler();

    // Auto-instrumentation breadcrumbs.
    const bc =
      options.breadcrumbs === false
        ? { console: false, fetch: false }
        : options.breadcrumbs && typeof options.breadcrumbs === 'object'
          ? { console: options.breadcrumbs.console !== false, fetch: options.breadcrumbs.fetch !== false }
          : { console: true, fetch: true };
    if (bc.console) wrapConsole();
    if (bc.fetch) wrapFetch();

    // Expose pour error-boundary.tsx (qui ne peut pas import ./index pour
    // cause d'import circulaire).
    (globalThis as { __pionne?: typeof Pionne }).__pionne = Pionne;

    if (isDev()) {
      // eslint-disable-next-line no-console
      console.log(
        '[Pionne] initialized',
        '·',
        'env=' + config.environment,
        '·',
        'release=' + (config.release ?? '—'),
      );
    }
  },

  /**
   * Manually capture an exception. Safe to call before init() (it'll no-op).
   */
  captureException(err: unknown, extra?: Partial<PionneEvent>): void {
    const event = buildEvent(err, extra?.level ?? 'error', 'manual', true, extra);
    if (event) send(event);
  },

  /**
   * Capture a string message (useful for non-error events).
   */
  captureMessage(message: string, extra?: Partial<PionneEvent>): void {
    const event = buildEvent(
      new Error(message),
      extra?.level ?? 'info',
      'manual',
      true,
      { exception_type: 'Message', ...extra },
    );
    if (event) send(event);
  },

  /**
   * Set / update the anonymous user id sent with every event.
   */
  setUser(userIdAnon: string | null): void {
    if (!config) return;
    config.userIdAnon = userIdAnon ?? undefined;
  },

  /**
   * Merge tags applied to every event. Pass null to clear.
   */
  setTags(tags: Record<string, string> | null): void {
    if (!config) return;
    config.tags = tags ?? undefined;
  },

  /**
   * Toggle reporting at runtime (e.g. after user opts out).
   */
  setEnabled(enabled: boolean): void {
    if (!config) return;
    config.enabled = enabled;
  },

  /**
   * Reference vers la View racine pour la capture d'écran. Pas requis si
   * `captureScreenshot` est désactivé. Pass `null` pour clear.
   */
  setRootRef(ref: { current: unknown } | null): void {
    _setRootRef(ref);
  },

  /**
   * Pousse un breadcrumb manuel (en plus de l'auto-instrumentation).
   *   Pionne.addBreadcrumb({ category: 'ui', message: 'tap "checkout"' });
   */
  addBreadcrumb(b: Omit<Breadcrumb, 'ts'> & { ts?: number }): void {
    _addBreadcrumb(b);
  },

  /**
   * Wrap une fonction (sync ou async) avec un try/catch qui capte
   * automatiquement toute erreur et la rejoue. La signature de la fonction
   * est conservée. Idéal pour les handlers d'évènements:
   *   onPress={Pionne.wrap(async () => { ... })}
   */
  wrap<F extends (...args: unknown[]) => unknown>(fn: F, tags?: Record<string, string>): F {
    return ((...args: Parameters<F>) => {
      try {
        const out = fn(...args);
        if (out instanceof Promise) {
          return out.catch((err: unknown) => {
            this.captureException(err, { level: 'error', tags });
            throw err;
          });
        }
        return out;
      } catch (err) {
        this.captureException(err, { level: 'error', tags });
        throw err;
      }
    }) as F;
  },
};
