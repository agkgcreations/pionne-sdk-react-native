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
import { getPendingNativeCrashes } from './native-crash';
import {
  type FeedbackContext,
  type FeedbackPayload,
  emitShowFeedback,
  sendFeedback as _sendFeedback,
} from './feedback';
import { PionneFeedbackModal } from './feedback-modal';
import {
  configureProfiler,
  profile as _profile,
  type ProfileMeta,
  startProfile as _startProfile,
  stopProfile as _stopProfile,
} from './profile';
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
  ProfilePayload,
} from './types';

export { PionneErrorBoundary, PionneFeedbackModal };
export type { Breadcrumb, FeedbackPayload, ProfileMeta };

export type {
  Level,
  Mechanism,
  MechanismType,
  PionneEvent,
  PionneOptions,
  ProfilePayload,
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
    // enableInDev is an init-time-only flag; once init() decides to
    // proceed, it doesn't live on the runtime config.
    | 'enableInDev'
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

/**
 * Posts an event to /api/ingest. Returns a Promise<boolean> that resolves
 * to true only when the server accepted the event (HTTP 2xx). False on
 * network error, 4xx (token/bundle/validation), 5xx, or rate-limit drop.
 *
 * The boolean lets callers decide whether to flip a release session to
 * 'errored'/'crashed' — a session marked crashed when the event itself
 * was rejected gives a confusing "1 crash · 0 events" in the dashboard.
 */
function send(event: PionneEvent): Promise<boolean> {
  if (!config) return Promise.resolve(false);
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
    return Promise.resolve(false);
  }
  // Si captureScreenshot activé, on l'attache de manière async juste avant
  // l'envoi.
  if (config.captureScreenshot) {
    return (async () => {
      try {
        const dataUri = await captureScreenshot(config!.screenshotQuality);
        if (dataUri) event = { ...event, screenshot: dataUri };
      } catch {
        // best-effort
      }
      return doSend(event);
    })();
  }
  return doSend(event);
}

/**
 * Schedules `send(event)` and flips the release session only if the
 * event was actually persisted server-side. Use this everywhere a flip
 * was previously paired with a fire-and-forget send. Avoids the
 * "session marked crashed without an event" false positive that
 * happens on bundle_id mismatches or transient network errors.
 *
 * Returns void — the caller doesn't need to await; the chain runs in
 * the background. The host app keeps going either way.
 */
function sendThenFlip(event: PionneEvent): void {
  void send(event).then((ok) => {
    if (ok) flipFromEvent(event);
  });
}

// Track 4xx rejections that indicate a permanent misconfig (bundle/token).
// We log loudly the first time *even in prod* so devs notice in TestFlight,
// then stay silent to not spam.
let warnedPermFailure = false;

function doSend(event: PionneEvent): Promise<boolean> {
  if (!config) return Promise.resolve(false);
  if (isDev()) {
    // eslint-disable-next-line no-console
    console.log('[Pionne] sending', event.exception_type, '→', config.endpoint);
  }
  // fetch is part of the React Native global polyfill, so no import needed.
  return fetch(config.endpoint, {
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
      // les surface au moins une fois (même en prod, ex: TestFlight) pour
      // que le dev les voie sans avoir à inspecter le réseau.
      if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 422)) {
        if (!warnedPermFailure) {
          warnedPermFailure = true;
          let body = '';
          try { body = await res.text(); } catch { /* ignore */ }
          // Try to parse a JSON error envelope so we can craft a specific
          // message per failure mode. Falls back to the raw body if parsing
          // fails or the server returned plain text/html.
          type ErrorEnvelope = { message?: string; expected_format?: string };
          let parsed: ErrorEnvelope | null = null;
          try { parsed = JSON.parse(body) as ErrorEnvelope; } catch { /* not JSON */ }
          const sentAppId = event.app_id ?? '<unset>';
          const serverMsg = parsed?.message ?? body.slice(0, 200);
          // eslint-disable-next-line no-console
          const warn = console.warn;

          if (res.status === 403 && /bundle\s*id/i.test(serverMsg)) {
            warn(
              `[Pionne] Bundle ID mismatch — your project rejects events from app_id="${sentAppId}". ` +
              `Server expected "${parsed?.expected_format ?? 'unknown'}" (1st char masked for safety). ` +
              `Fix it in your Pionne project Settings → Bundle ID to match your native app, ` +
              `or clear the field to disable the check (rétrocompat). ` +
              `Subsequent rejections will be silent for this session.`,
            );
          } else if (res.status === 401) {
            warn(
              `[Pionne] Token rejected (401). Check EXPO_PUBLIC_PIONNE_TOKEN matches your project token ` +
              `(starts with "pio_live_…"). Server said: ${serverMsg}. ` +
              `Subsequent rejections will be silent for this session.`,
            );
          } else if (res.status === 422) {
            warn(
              `[Pionne] Event rejected (422 validation): ${serverMsg}. ` +
              `Sent app_id="${sentAppId}". Subsequent rejections will be silent for this session.`,
            );
          } else {
            warn(
              `[Pionne] Event rejected (status=${res.status}): ${serverMsg}. ` +
              `Sent app_id="${sentAppId}". Subsequent rejections will be silent for this session.`,
            );
          }
        }
      }
      return res.ok;
    })
    .catch((e) => {
      if (isDev()) {
        // eslint-disable-next-line no-console
        console.warn('[Pionne] send failed', e);
      }
      return false;
    });
}

/**
 * Drain the native crashes the OS recorded on previous run(s) and replay each
 * as a `fatal` event. These come from a *past* process, so we use plain
 * `send()` — never `sendThenFlip()`, which would wrongly mark the *current*
 * session as crashed.
 *
 * Runs once at init and once ~5s later: MetricKit delivers its payload
 * asynchronously a few seconds into the launch that follows the crash, so the
 * delayed pass catches a crash surfaced during this very session. The native
 * `getPendingNativeCrashes()` clears on read, so the two passes never
 * double-report.
 */
function replayNativeCrashes(): void {
  void getPendingNativeCrashes().then((records) => {
    for (const r of records) {
      const err = new Error(r.message || r.type || 'Native crash');
      err.name = r.type || 'NativeCrash';
      const event = buildEvent(err, 'fatal', 'native', false, {
        stack: r.stack && r.stack.length ? r.stack : undefined,
        app_version: r.appVersion ?? staticContext.app_version,
        os_version: r.osVersion ?? staticContext.os_version,
        tags: {
          ...(config?.tags ?? {}),
          'native.source': r.platform === 'ios' ? 'metrickit' : 'app_exit',
          'native.crashed_at': new Date(r.timestamp).toISOString(),
        },
      });
      if (event) void send(event);
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
    if (event) sendThenFlip(event);
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
        if (event) sendThenFlip(event);
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
      // Opt-out: skip the SDK entirely in __DEV__ when the host asked
      // for it. Avoids polluting the prod dashboard with dev events
      // and dodges the bundle ID mismatch headache between Expo Go
      // and the bundle pinned on the project.
      if (isDev() && options?.enableInDev === false) {
        console.info('[Pionne] Skipped in __DEV__ (enableInDev=false). Will activate in production.');
        return;
      }

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
      captureNativeCrashes: options.captureNativeCrashes ?? true,
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
        if (event) sendThenFlip(event);
      });
    }
    if (config.captureUnhandledRejections) installPromiseRejectionHandler();

    // Profiler — wire up the same endpoint/token so Pionne.startProfile
    // can ship samples without the dev passing them again. The actual
    // sampler stays idle until startProfile() is called.
    configureProfiler({
      endpoint: config!.endpoint,
      token: config!.token,
      release: config!.release,
      environment: config!.environment,
      appVersion: staticContext.app_version,
    });

    // Release Health — open a session unless the host opted out. We send
    // status='ok' immediately and rely on flipFromEvent() to upgrade to
    // 'crashed'/'errored' if a fatal hits.
    if (options.releaseHealth !== false) {
      // TS loses the non-null narrowing on `config` across the inline
      // closures above (fetchGeo, etc.). We just assigned it 30 lines
      // up, so the `!` is safe here and below.
      _startSession({
        endpoint: config!.endpoint,
        token: config!.token,
        release: config!.release,
        environment: config!.environment,
        appVersion: staticContext.app_version,
        osName: staticContext.os_name,
        userIdAnon: config!.userIdAnon,
        appId: config!.appId,
      });
    }

    // Native crashes from previous run(s) (MetricKit / ApplicationExitInfo).
    // No-op in Expo Go / web where the native module isn't linked.
    if (config.captureNativeCrashes) {
      replayNativeCrashes();
      // Second pass: MetricKit delivers ~a few seconds after launch.
      setTimeout(replayNativeCrashes, 5000);
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
        'env=' + config!.environment,
        '·',
        'release=' + (config!.release ?? '—'),
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
    // No flipFromEvent on manual captures: the dev chose to record this
    // event explicitly (e.g. caught + handled). Manual
    // capture doesn't affect session health.
    if (event) void send(event);
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
    if (event) void send(event);
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

  // ─── Profiling (Hermes only) ──────────────────────────────────────────

  /**
   * Begin sampling the JS thread under a named profile. Pair with
   * `Pionne.stopProfile()` (which uploads the trace) — call them around
   * the code path you want to inspect in the dashboard's flame graph.
   *
   * No-op (returns false) on JSC or any runtime that doesn't expose
   * Hermes' sampling profiler. Calling start while another profile is
   * active flushes the previous one and starts fresh — favoring your
   * latest intent.
   *
   * Example:
   *   const ok = Pionne.startProfile('CheckoutFlow', { route: '/checkout' });
   *   await runCheckout();
   *   await Pionne.stopProfile();
   */
  startProfile(name: string, meta?: ProfileMeta): boolean {
    return _startProfile(name, meta);
  },

  /**
   * Stop the active profile and upload its samples to /api/profiles.
   * Safe to call when no profile is running (no-op). Always resolves —
   * monitoring SDKs must never throw. Returns the server-assigned
   * `profile_id` on success, `null` on any failure.
   */
  stopProfile(): Promise<number | null> {
    return _stopProfile();
  },

  /**
   * Sugar — wraps a function/promise in start/stop. Returns whatever
   * the wrapped fn returns (or rejects with). Profiling failures never
   * block the wrapped fn.
   *
   * Example:
   *   const order = await Pionne.profile('CheckoutFlow', () => createOrder(items));
   */
  profile<T>(name: string, fn: () => T | Promise<T>, meta?: ProfileMeta): Promise<T> {
    return _profile(name, fn, meta);
  },
};
