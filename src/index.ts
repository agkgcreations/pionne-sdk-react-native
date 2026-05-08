import {
  addBreadcrumb as _addBreadcrumb,
  type Breadcrumb,
  getBreadcrumbs,
  wrapConsole,
  wrapFetch,
} from './breadcrumbs';
import { gatherStaticContext } from './context';
import { PionneErrorBoundary } from './error-boundary';
import { fetchGeo, getGeo } from './geo';
import {
  type FeedbackContext,
  type FeedbackPayload,
  emitShowFeedback,
  sendFeedback as _sendFeedback,
} from './feedback';
import { PionneFeedbackModal } from './feedback-modal';
import { captureScreenshot, setRootRef as _setRootRef } from './screenshot';
import { DEFAULT_PATTERNS, scrubDeep, type ScrubPattern } from './scrubber';
import { RateLimiter, validateEndpoint, validateToken } from './security';
import {
  endSession as _endSession,
  flipFromEvent,
  getCurrentSessionId,
  startSession as _startSession,
} from './sessions';
import { wrapTimers } from './timers';
import type {
  Level,
  Mechanism,
  MechanismType,
  PionneEvent,
  PionneOptions,
} from './types';

export { PionneErrorBoundary, PionneFeedbackModal };
export type { Breadcrumb, FeedbackPayload };

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
    | 'releaseHealth'
    | 'maxEventsPerSecond'
    | 'sendGeography'
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
let rateLimiter: RateLimiter | null = null;
let droppedByRateLimit = 0;

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

  // Geo context (opt-in via sendGeography). Best-effort: if the lookup
  // hasn't returned yet on the very first event, we just skip it — it'll
  // be attached on subsequent events for the rest of the session.
  const geo = getGeo();
  if (geo && Object.keys(geo).length) {
    event.contexts = { ...(event.contexts ?? {}), geo };
  }

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
  // Client-side rate limit — drops events beyond maxEventsPerSecond to
  // protect the host from a runaway loop and the user from blowing
  // through their monthly quota. We log the drop count once per minute
  // in dev so the user notices the cap kicking in.
  if (rateLimiter && !rateLimiter.allow()) {
    droppedByRateLimit++;
    if (isDev() && droppedByRateLimit % 50 === 1) {
      // eslint-disable-next-line no-console
      console.warn(`[Pionne] rate-limit reached (${droppedByRateLimit} events dropped). Bump maxEventsPerSecond if intentional.`);
    }
    return;
  }
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

// Track 4xx rejections that indicate a permanent misconfig (bundle/token).
// We log loudly the first time *even in prod* so devs notice in TestFlight,
// then stay silent to not spam.
let warnedPermFailure = false;

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
    .then(async (res) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.log('[Pionne] response', res.status);
      }
      // 401/403 = config problem (token invalide / bundle mismatch). 422 =
      // validation. Toutes ces erreurs ne se résoudront jamais en retry — on
      // les surface au moins une fois pour que le dev les voie en TestFlight.
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 422)) {
        if (!warnedPermFailure) {
          warnedPermFailure = true;
          let body = '';
          try { body = await res.text(); } catch { /* ignore */ }
          // eslint-disable-next-line no-console
          console.warn(
            '[Pionne] event rejected (permanent) — status=' + res.status +
            ' body=' + body.slice(0, 200) +
            '. Subsequent rejections will be silent. Check token + project bundle_id.',
          );
        }
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
    if (event) {
      send(event);
      flipFromEvent(event);
    }
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
        if (event) {
          send(event);
          flipFromEvent(event);
        }
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
    // Defensive try/catch around the whole init — a monitoring SDK must
    // NEVER crash the host. Any unexpected throw here is swallowed with a
    // dev-only warning; the host app keeps booting.
    try {
      if (!options?.token || !validateToken(options.token)) {
        if (isDev()) {
          console.warn('[Pionne] Missing or invalid token (expected pio_live_<≥16 chars>, no placeholders).');
        }
        return;
      }
      const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
      if (!validateEndpoint(endpoint, isDev())) {
        if (isDev()) {
          console.warn('[Pionne] Refusing non-HTTPS endpoint in production:', endpoint);
        }
        return;
      }
      // Token-bucket rate limiter — caps runaway error loops at
      // maxEventsPerSecond (default 10). Set to 0 to disable.
      const rps = options.maxEventsPerSecond ?? 10;
      rateLimiter = rps > 0 ? new RateLimiter(rps, rps) : null;

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
        if (event) {
          send(event);
          flipFromEvent(event);
        }
      });
    }
    if (config.captureUnhandledRejections) installPromiseRejectionHandler();

    // Release Health — open a session unless the host opted out. We send
    // status='ok' immediately and rely on flipFromEvent() to upgrade to
    // 'crashed'/'errored' if a fatal hits.
    if (options.releaseHealth !== false) {
      _startSession({
        endpoint: config.endpoint,
        token: config.token,
        release: config.release,
        environment: config.environment,
        appVersion: staticContext.app_version,
        osName: staticContext.os_name,
        userIdAnon: config.userIdAnon,
        appId: config.appId,
      });
    }

    // Geography lookup (opt-in). Fire-and-forget — the result is cached
    // for the rest of the session and attached to every event via
    // contexts.geo. Failures are silent (no retry), so a flaky lookup
    // never costs more than ~4s of background fetch on init.
    if (options.sendGeography) {
      const geoCfg =
        typeof options.sendGeography === 'object' ? options.sendGeography : undefined;
      void fetchGeo(geoCfg);
    }

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
    } catch (e) {
      // Defensive — a monitoring SDK that crashes the host is worse than
      // no monitoring at all. Swallow + warn in dev only.
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn('[Pionne] init failed silently — monitoring disabled.', e);
      }
      config = null;
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

  // ─── Release Health ───────────────────────────────────────────────────

  /** Manually end the current session (status='exited'). Most apps don't
   *  need this — `init()` opens a session automatically. */
  endSession(): void {
    _endSession();
  },

  /** UUID of the current open session (for diagnostics). */
  getSessionId(): string | null {
    return getCurrentSessionId();
  },

  // ─── User Feedback ────────────────────────────────────────────────────

  /** Pop the <PionneFeedbackModal/> mounted in the host tree. Optionally
   *  attach the feedback to a specific event ID. */
  showFeedback(opts?: { eventId?: number | string; defaults?: Partial<FeedbackPayload> }): void {
    emitShowFeedback(opts ?? {});
  },

  /** Send a feedback payload directly without showing the Modal. Useful
   *  for power users with a custom UI. */
  async captureFeedback(payload: FeedbackPayload): Promise<{ ok: boolean; status: number }> {
    if (!config) return { ok: false, status: 0 };
    return _sendFeedback(
      {
        endpoint: config.endpoint,
        token: config.token,
        appVersion: staticContext.app_version,
      },
      payload,
    );
  },

  /** Internal — for the <PionneFeedbackModal/> to know which token/endpoint
   *  to use. Returns null if init() has not run yet. */
  getFeedbackContext(): FeedbackContext | null {
    if (!config) return null;
    return {
      endpoint: config.endpoint,
      token: config.token,
      appVersion: staticContext.app_version,
    };
  },
};
