export type Level = 'fatal' | 'error' | 'warning' | 'info';

export type MechanismType =
  | 'onerror'
  | 'onunhandledrejection'
  | 'manual'
  | 'react_error_boundary';

export interface Mechanism {
  type: MechanismType;
  handled: boolean;
}

// =====================================================================
// CONTEXTS — Sentry-style nested groups. Every key is optional; the SDK
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

export interface PionneContexts {
  os?: OsContext;
  device?: DeviceContext;
  app?: AppContext;
  ota?: OtaContext;
  runtime?: RuntimeContext;
  expo_constants?: ExpoConstantsContext;
  sdk?: SdkContext;
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
  /** Bundle ID — vérifié contre `projects.bundle_id` si configuré. */
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

  // ─── Sentry-style nested ──────────────────────────────────────
  contexts?: PionneContexts;
  mechanism?: Mechanism;
  breadcrumbs?: Array<Record<string, unknown>>;
  tags?: Record<string, string>;

  // ─── Screenshot — opt-in, capturée à l'envoi (PDF §11) ───────
  // data URI base64 (image/jpeg|png). Le serveur la décode et la
  // stocke en /storage/screenshots/{project}/{event}.jpg.
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
  /** Auto-capture uncaught JS exceptions via ErrorUtils. Default: true. */
  captureUncaughtErrors?: boolean;
  /** Auto-capture unhandled promise rejections. Default: true. */
  captureUnhandledRejections?: boolean;
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
   * Bundle ID de l'app. Si le projet Pionne a un `bundle_id` configuré
   * côté serveur, le SDK l'envoie dans `app_id` et l'API rejette les
   * events qui ne matchent pas. Mitige le token theft.
   * Auto-détecté via `expo-application` si non fourni.
   */
  appId?: string;
  /**
   * PII scrubbing — remplace email, CB, IBAN, JWT, IP, téléphone, tokens
   * par des placeholders avant l'envoi. RGPD-friendly.
   *  - `true` (défaut): patterns par défaut
   *  - `false`: désactivé
   *  - tableau: tes propres patterns en plus des défauts
   */
  scrubPii?: boolean | Array<{ re: RegExp; replace: string }>;
  /**
   * Drop-rate anti-flood: 1 = 100% des events partent, 0.1 = 10%.
   * Défaut: 1. Utile pour les apps avec >100k events/jour.
   */
  sampleRate?: number;
  /**
   * Auto-instrumentation pour reconstituer ce que l'user faisait avant le crash.
   *  - `console`: wrap console.log/info/warn/error
   *  - `fetch`: wrap fetch (méthode + URL stripped + status + ms)
   * `true` (défaut) = les deux. Passe `false` ou `{ console: false }` pour cibler.
   */
  breadcrumbs?: boolean | { console?: boolean; fetch?: boolean };
  /**
   * Capture d'écran de la vue racine au moment de l'erreur (PDF §11).
   * Nécessite la peer dep optionnelle `react-native-view-shot` et un
   * `Pionne.setRootRef(ref)` une fois ton `<View>` racine monté.
   * Default: false.
   */
  captureScreenshot?: boolean;
  /** Quality JPEG (0..1) pour le screenshot. Default: 0.5. */
  screenshotQuality?: number;
}
