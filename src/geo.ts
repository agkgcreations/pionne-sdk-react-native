// Geography resolver — opt-in via `sendGeography: true` (PionneOptions).
//
// Best-effort IP-based lookup. We don't ask for GPS permission — the IP
// alone gives city/region/country precision, which is enough for crash
// debugging without crossing the privacy line.
//
// Resolved once per process (the user is unlikely to teleport between
// crashes within the same session). The result is cached and re-used.

import type { GeoContext } from './types';

const DEFAULT_ENDPOINT = 'https://ipapi.co/json/';
const TIMEOUT_MS = 4000;

let cached: GeoContext | null | undefined; // undefined = not fetched yet
let inflight: Promise<GeoContext | null> | null = null;

export interface GeoConfig {
  endpoint?: string;
  resolve?: () => Promise<GeoContext | null>;
}

/**
 * Returns the cached geo context, or `null` if not yet fetched / lookup
 * failed. Non-blocking: never throws, never re-fetches if a previous
 * attempt failed (we accept missing geo rather than spamming the lookup
 * service on every event).
 */
export function getGeo(): GeoContext | null {
  return cached ?? null;
}

/**
 * Kicks off the lookup. Idempotent — repeated calls share the same
 * inflight promise, and a successful result is cached for the rest of
 * the process. Failures cache `null` (no retries within the session).
 */
export function fetchGeo(config?: GeoConfig): Promise<GeoContext | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // Custom resolver wins — useful for power users who want a
      // privacy-friendlier service or a server-side proxy.
      if (config?.resolve) {
        const result = await withTimeout(config.resolve(), TIMEOUT_MS);
        cached = result ?? null;
        return cached;
      }

      const endpoint = config?.endpoint ?? DEFAULT_ENDPOINT;
      const res = await withTimeout(
        fetch(endpoint, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }),
        TIMEOUT_MS,
      );
      if (!res.ok) {
        cached = null;
        return null;
      }
      const json = (await res.json()) as Record<string, unknown>;
      cached = normalize(json);
      return cached;
    } catch {
      // Lookup failed (network, timeout, parse). Cache null so we don't
      // retry on every event for the rest of the session.
      cached = null;
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Tests-only / hot-reload helper — clear the cache so a fresh fetch can
 * happen. Not exposed in the public API.
 */
export function _resetGeoCacheForTests(): void {
  cached = undefined;
  inflight = null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('geo lookup timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Different IP-geo services use different field names. We accept the
 * common shapes (ipapi.co, ipinfo.io, ip-api.com) and pick what we know.
 */
function normalize(raw: Record<string, unknown>): GeoContext {
  const out: GeoContext = {};
  const city = pickString(raw, ['city']);
  if (city) out.city = city;
  const region = pickString(raw, ['region', 'region_name', 'regionName']);
  if (region) out.region = region;
  const country = pickString(raw, ['country_name', 'country']);
  if (country && country.length > 2) out.country = country;
  const cc = pickString(raw, ['country_code', 'countryCode', 'country']);
  if (cc && cc.length === 2) out.country_code = cc.toUpperCase();
  return out;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}
