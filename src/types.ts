export type Level = 'fatal' | 'error' | 'warning' | 'info';

export type MechanismType =
  | 'onerror'
  | 'onunhandledrejection'
  | 'manual'
  | 'react_error_boundary'
  // Native crash (Objective-C/Swift exception, signal, OOM, ANR…) captured by
  // the OS and replayed on the next launch via MetricKit (iOS) /
  // ApplicationExitInfo (Android). Requires a dev/production build — never
  // fires in Expo Go.
  | 'native';

export interface Mechanism {
  type: MechanismType;
  handled: boolean;
}

// =====================================================================
// CONTEXTS — nested groups. Every key is optional; the SDK
// fills in what it can detect at runtime, and the API stores it as JSON.
// =====================================================================

export interface OsContext {
  name?: string;
  version?: string;
  build?: string;
  kernel_version?: string;
  rooted?: boolean;
}

export interface DeviceContext {
  name?: string;
  family?: string;
  model?: string;
  model_id?: string;
  brand?: string;
  manufacturer?: string;
  arch?: string;
  type?: 'phone' | 'tablet' | 'desktop' | 'tv' | 'unknown';
  year_class?: number;
  cpu_count?: number;
  memory_size?: number;
  free_memory?: number;
  usable_memory?: number;
  storage_size?: number;
  free_storage?: number;
  battery_level?: number;
  charging?: boolean;
  low_power_mode?: boolean;
  thermal_state?: string;
  screen_width_pixels?: number;
  screen_height_pixels?: number;
  screen_density?: number;
  orientation?: 'portrait' | 'landscape';
  simulator?: boolean;
  locale?: string;
  timezone?: string;
}

export interface AppContext {
  name?: string;
  bundle_id?: string;
  version?: string;
  build?: string;
  build_type?: string;
  identifier?: string;
  in_foreground?: boolean;
  start_time?: string;
  memory_usage?: number;
  installation_time?: string;
}

export interface OtaContext {
  is_enabled?: boolean;
  is_embedded_launch?: boolean;
  is_emergency_launch?: boolean;
  is_using_embedded_assets?: boolean;
  check_automatically?: string;
  update_id?: string;
  channel?: string;
  runtime_version?: string;
  launch_duration?: number;
  created_at?: string;
}

export interface RuntimeContext {
  name?: string;
  version?: string;
  js_engine?: string;
  hermes?: boolean;
  hermes_version?: string;
  hermes_debug_info?: boolean;
  fabric?: boolean;
  turbo_module?: boolean;
  expo?: boolean;
  react_native_version?: string;
}

export interface ExpoConstantsContext {
  debug_mode?: boolean;
  execution_environment?: string;
  session_id?: string;
  status_bar_height?: number;
  app_ownership?: string;
}

export interface SdkContext {
  name: string;
  version: string;
}

/**
 * Approximate user geography, opt-in via `sendGeography: true`.
 * Resolved IP-side (no GPS, no permission). Best-effort; may be `{}` if
 * the SDK couldn't reach the lookup service or if VPN/CDN strips it.
 */
export interface GeoContext {
  city?: string;
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2 (e.g. "FR", "US"). */
  country_code?: string;
}

export interface PionneContexts {
  os?: OsContext;
  device?: DeviceContext;
  app?: AppContext;
  ota?: OtaContext;
  runtime?: RuntimeContext;
  expo_constants?: ExpoConstantsContext;
  sdk?: SdkContext;
  geo?: GeoContext;
}

// =====================================================================
// EVENT
// =====================================================================

export interface PionneEvent {
  // ─── Required ─────────────────────────────────────────────────
  exception_type: string;

  // ─── Error payload ────────────────────────────────────────────
  message?: string | null;
  stack?: string[];
  level?: Level;

  // ─── Flat (kept for backward compat & quick filtering) ───────
  release?: string;
  environment?: string;
  app_version?: string;
  app_build?: string;
  /** Bundle ID — checked against `projects.bundle_id` if the project has it set. */
  app_id?: string;
  os_name?: string;
  os_version?: string;
  device_model?: string;
  device_brand?: string;
  device_manufacturer?: string;
  is_device?: boolean;
  ota_update_id?: string;
  ota_channel?: string;
  runtime_version?: string;
  user_id_anon?: string;
  locale?: string;
  timezone?: string;

  // ─── nested ──────────────────────────────────────
  contexts?: PionneContexts;
  mechanism?: Mechanism;
  breadcrumbs?: Array<Record<string, unknown>>;
  tags?: Record<string, string>;

  // ─── Screenshot — opt-in, captured at send time ───────
  // base64 data URI (image/jpeg|png). The server decodes it and stores it
  // at /storage/screenshots/{project}/{event}.jpg.
  screenshot?: string;
}

// =====================================================================
// OPTIONS
// =====================================================================

export interface PionneOptions {
  /** Project token (starts with `pio_live_`). Required. */
  token: string;
  /** Override the ingest endpoint. Default: production Pionne. */
  endpoint?: string;
  /** App release / version. Defaults to native app version when expo-application is installed. */
  release?: string;
  /** Environment label. Default: "development" in __DEV__, "production" otherwise. */
  environment?: string;
  /** Disable all reporting if false. Default: true. */
  enabled?: boolean;
  /**
   * Whether to send events when the app runs in `__DEV__` (Metro / Expo
   * Go / dev build). Default: `true` for backwards compatibility.
   *
   * Pass `false` to silence the SDK in dev — useful to avoid polluting
   * the production dashboard with noise from local debugging, and to
   * sidestep bundle ID mismatches between Expo Go (`host.exp.Exponent`)
   * and the bundle ID pinned on your project.
   *
   * When false in `__DEV__`, `init()` is a no-op (no global handlers
   * installed, no session opened, no geo lookup). All `Pionne.captureXxx`
   * calls also no-op silently.
   */
  enableInDev?: boolean;
  /** Auto-capture uncaught JS exceptions via ErrorUtils. Default: true. */
  captureUncaughtErrors?: boolean;
  /** Auto-capture unhandled promise rejections. Default: true. */
  captureUnhandledRejections?: boolean;
  /**
   * Capture **native** crashes (Objective-C/Swift exceptions, signals like
   * SIGSEGV/SIGABRT, OOM kills, ANRs) that take down the whole process before
   * any JS handler can run. The OS records them (MetricKit on iOS 14+,
   * ApplicationExitInfo on Android 11+) and the SDK replays them as `fatal`
   * events on the **next launch**.
   *
   * Requires a development or production build (`expo prebuild` / EAS) — the
   * native module is absent from Expo Go, where this option silently no-ops.
   * Default: true.
   */
  captureNativeCrashes?: boolean;
  /** Auto-detect device + app + OTA + runtime context. Default: true. */
  autoContext?: boolean;
  /** Last hook before sending — return null to drop the event. */
  beforeSend?: (event: PionneEvent) => PionneEvent | null;
  /** Anonymous user id, included in every event for grouping by user. */
  userIdAnon?: string;
  /** Static tags merged into every event. */
  tags?: Record<string, string>;
  /** Maximum stack frames sent. Default: 50. */
  maxStackFrames?: number;
  /**
   * App bundle ID. If the Pionne project has `bundle_id` set server-side,
   * the SDK ships it in `app_id` and the API rejects events that don't
   * match. Mitigates token theft. Auto-detected via `expo-application`
   * when not provided.
   */
  appId?: string;
  /**
   * PII scrubbing — replaces email, card, IBAN, JWT, IP, phone, tokens
   * with placeholders before send. GDPR-friendly.
   *  - `true` (default): default patterns
   *  - `false`: disabled
   *  - array: your own patterns on top of the defaults
   */
  scrubPii?: boolean | Array<{ re: RegExp; replace: string }>;
  /**
   * Anti-flood drop rate: 1 = 100% of events ship, 0.1 = 10%.
   * Default: 1. Useful for apps with >100k events/day.
   */
  sampleRate?: number;
  /**
   * Auto-instrumentation to reconstruct what the user was doing before the crash.
   *  - `console`: wrap console.log/info/warn/error
   *  - `fetch`: wrap fetch (method + stripped URL + status + ms)
   * `true` (default) = both. Pass `false` or `{ console: false }` to narrow.
   */
  breadcrumbs?: boolean | { console?: boolean; fetch?: boolean };
  /**
   * Screenshot of the root view at the moment of the error. Requires the
   * optional peer dep `react-native-view-shot` and a `Pionne.setRootRef(ref)`
   * once your root `<View>` is mounted.
   * Default: false.
   */
  captureScreenshot?: boolean;
  /** Quality JPEG (0..1) pour le screenshot. Default: 0.5. */
  screenshotQuality?: number;
  /**
   * Release Health — opens a session at init() with status='ok' and flips
   * it to 'crashed'/'errored' if a fatal/uncaught error fires. The
   * dashboard derives crash-free user rate per release from these.
   * Default: true. Set to false to disable session tracking entirely.
   */
  releaseHealth?: boolean;
  /**
   * Maximum events sent per second (token bucket). Anything beyond is
   * silently dropped. Protects the host from a runaway error loop AND
   * caps the worst-case impact on your monthly Pionne quota.
   * Default: 10. Set to 0 to disable the limit entirely (not
   * recommended in production).
   */
  maxEventsPerSecond?: number;
  /**
   * Approximate user geography (city / region / country / country_code),
   * resolved IP-side via a free public service. Attached to every event
   * as `contexts.geo`. **Opt-in** — disabled by default for privacy.
   *  - `true`: enable with default service (`https://ipapi.co/json/`)
   *  - object: customize the endpoint or supply your own resolver
   * Default: `false`.
   */
  sendGeography?: boolean | { endpoint?: string; resolve?: () => Promise<GeoContext | null> };
}

// ─── Profiling — payload the SDK ships to POST /api/profiles ──────────

export interface ProfilePayload {
  /** Human-readable label set via Pionne.startProfile(name). */
  name: string;
  /** Wall-clock duration of the captured profile, in milliseconds. */
  duration_ms: number;
  /** Number of stack samples collected during the run. */
  samples_count: number;
  /** Sampler interval in microseconds — Hermes default = 1000 (1 ms). */
  sample_interval_us: number;
  /**
   * Raw trace blob — Chrome Trace Event Format from Hermes (default), or
   * collapsed-stack JSON (`[{ stack: 'a;b;c', weight_us: 123 }, …]`) if
   * you transcoded another sampler. The backend's aggregator accepts
   * both shapes.
   */
  samples: unknown;
  /** Optional app route this profile relates to — '/checkout', etc. */
  route?: string;
  /** Optional crash event id to link this profile to in the dashboard. */
  event_id?: number;
}
