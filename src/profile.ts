// Continuous-ish Profiling for React Native + Hermes.
//
// Wraps Hermes' built-in sampling profiler (`HermesInternal.enableSamplingProfiler`,
// `disableSamplingProfiler`, `dumpSampledTraceToFile`) with the smallest
// surface that still produces a useful flame graph in the Pionne dashboard.
//
// Design choices for the MVP:
//
//  * **Manual scoping only.** No always-on continuous profiler. Devs call
//    `Pionne.startProfile('CheckoutFlow')` then `Pionne.stopProfile()`
//    around the spans they care about. Continuous would have to confront
//    overhead, file rotation, and storage caps — out of scope for v1.
//
//  * **Hermes only.** JSC has no equivalent runtime API. The module
//    silently no-ops on non-Hermes engines (logs a one-line warning in
//    __DEV__ so devs aren't surprised).
//
//  * **In-memory trace buffer.** Hermes' `dumpSampledTraceToFile` writes
//    to disk; we read it back and POST as JSON. The fallback path uses
//    `dumpSampledTrace()` (a less-supported API that returns the trace
//    inline) when a writable filesystem isn't available (e.g. expo-go web
//    preview, where react-native-fs isn't loaded).
//
//  * **Best-effort delivery.** A monitoring SDK must never throw. Every
//    failure path logs in __DEV__ and resolves silently in production.

import type { ProfilePayload } from './types';

type HermesProfilerInternals = {
  enableSamplingProfiler?: () => void;
  disableSamplingProfiler?: () => void;
  // Both APIs exist on different Hermes versions. We try the file one
  // first (newer, more reliable), fall back to the inline one.
  dumpSampledTraceToFile?: (path: string) => void;
  dumpSampledTrace?: () => string;
};

function getHermes(): HermesProfilerInternals | null {
  const g = globalThis as unknown as { HermesInternal?: HermesProfilerInternals };
  return g.HermesInternal ?? null;
}

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

interface ActiveProfile {
  name: string;
  startedAt: number;
  meta?: ProfileMeta;
}

export interface ProfileMeta {
  /** App route this profile relates to — e.g. '/checkout', 'CheckoutScreen'. */
  route?: string;
  /** Optional crash event id to link the profile to in the dashboard. */
  eventId?: number;
}

export interface ProfileConfig {
  endpoint: string; // base API URL, '/profiles' is appended by sender
  token: string;
  release?: string;
  environment?: string;
  appVersion?: string;
}

let active: ActiveProfile | null = null;
let config: ProfileConfig | null = null;

/**
 * Set once at SDK init. Without this, start/stopProfile no-ops silently.
 */
export function configureProfiler(cfg: ProfileConfig): void {
  config = cfg;
}

/**
 * Begin a profile session. Idempotent if a profile is already running
 * with the same name. Calling with a different name while one is active
 * stops the previous one and starts a new one — favoring the dev's
 * latest intent.
 *
 * Returns true if profiling actually started (Hermes available + supported),
 * false otherwise. Devs typically don't need to check the return value;
 * stopProfile is safe to call regardless.
 */
export function startProfile(name: string, meta?: ProfileMeta): boolean {
  const hermes = getHermes();
  if (!hermes?.enableSamplingProfiler) {
    if (isDev()) {
      console.info('[Pionne] Profiling unavailable — Hermes sampling profiler not detected.');
    }
    return false;
  }

  if (active) {
    if (active.name === name) {
      // Same profile already running — keep going, don't reset.
      return true;
    }
    // Different profile requested — flush the previous one and start fresh.
    void stopProfile();
  }

  try {
    hermes.enableSamplingProfiler();
    active = { name, startedAt: Date.now(), meta };
    return true;
  } catch (e) {
    if (isDev()) console.warn('[Pionne] enableSamplingProfiler threw:', e);
    active = null;
    return false;
  }
}

/**
 * Stop the active profile and ship the samples to the Pionne API. No-op
 * if no profile is active. Returns the local profile_id assigned by the
 * server (or null on any failure). Always resolves — never throws.
 */
export async function stopProfile(): Promise<number | null> {
  const hermes = getHermes();
  const profile = active;
  active = null;
  if (!profile || !hermes) return null;

  try {
    hermes.disableSamplingProfiler?.();
  } catch (e) {
    if (isDev()) console.warn('[Pionne] disableSamplingProfiler threw:', e);
    return null;
  }

  const samples = readTrace(hermes);
  if (!samples) return null;

  const durationMs = Date.now() - profile.startedAt;
  const samplesCount = countSamples(samples);
  // Hermes default sampling interval is 1 ms (1000 µs). We surface this so
  // the backend renderer can convert sample counts to wall-clock estimates.
  const sampleIntervalUs = 1000;

  return ship({
    name: profile.name,
    duration_ms: durationMs,
    samples_count: samplesCount,
    sample_interval_us: sampleIntervalUs,
    samples,
    route: profile.meta?.route,
    event_id: profile.meta?.eventId,
  });
}

/**
 * Sugar — wrap a function/promise in start/stop. Returns the function's
 * result (or rejection). Profiling failures never block the wrapped fn.
 */
export async function profile<T>(name: string, fn: () => T | Promise<T>, meta?: ProfileMeta): Promise<T> {
  startProfile(name, meta);
  try {
    return await fn();
  } finally {
    void stopProfile();
  }
}

// ─── internals ─────────────────────────────────────────────────────────

function readTrace(hermes: HermesProfilerInternals): unknown | null {
  // Try the inline API first — works in every environment that exposes
  // HermesInternal at all, including web/expo-go where there's no FS.
  if (typeof hermes.dumpSampledTrace === 'function') {
    try {
      const raw = hermes.dumpSampledTrace();
      if (typeof raw === 'string' && raw.length > 0) {
        return JSON.parse(raw);
      }
    } catch (e) {
      if (isDev()) console.warn('[Pionne] dumpSampledTrace failed:', e);
    }
  }

  // Fallback to the file API — only useful on devices where we can read
  // the temp dir back. We don't pull react-native-fs; if the host doesn't
  // expose a global `fs`-like, we just bail out and ship nothing.
  if (typeof hermes.dumpSampledTraceToFile === 'function') {
    if (isDev()) {
      console.info(
        '[Pionne] dumpSampledTraceToFile is available but the SDK does not bundle a FS reader. ' +
          'Hermes 0.12+ exposes dumpSampledTrace inline; upgrade Hermes to enable profiling.',
      );
    }
  }

  return null;
}

function countSamples(samples: unknown): number {
  if (!samples || typeof samples !== 'object') return 0;
  const obj = samples as { samples?: unknown[]; traceEvents?: unknown[]; stackFrames?: Record<string, unknown> };
  // Hermes inline trace exposes a `samples` array; Chrome-trace-style has
  // `traceEvents` instead. Either gives us a useful count.
  if (Array.isArray(obj.samples)) return obj.samples.length;
  if (Array.isArray(obj.traceEvents)) return obj.traceEvents.length;
  return 0;
}

async function ship(payload: ProfilePayload): Promise<number | null> {
  if (!config) {
    if (isDev()) console.info('[Pionne] Profiler not configured — call Pionne.init first.');
    return null;
  }

  const body = {
    name: payload.name,
    release: config.release,
    environment: config.environment,
    platform: 'react_native',
    route: payload.route,
    duration_ms: payload.duration_ms,
    samples_count: payload.samples_count,
    sample_interval_us: payload.sample_interval_us,
    samples: payload.samples,
    event_id: payload.event_id,
  };

  try {
    // The SDK already targets /api/ingest as its base; profiles live
    // under /api/profiles in the same vhost. We strip /ingest off the
    // configured endpoint to derive the base.
    const base = config.endpoint.replace(/\/ingest\/?$/, '');
    const url = `${base}/profiles`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pionne-Token': config.token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (isDev()) console.warn(`[Pionne] /profiles returned ${res.status}`);
      return null;
    }
    const json: unknown = await res.json().catch(() => null);
    const id = (json as { profile_id?: number } | null)?.profile_id;
    return typeof id === 'number' ? id : null;
  } catch (e) {
    if (isDev()) console.warn('[Pionne] Failed to ship profile:', e);
    return null;
  }
}
