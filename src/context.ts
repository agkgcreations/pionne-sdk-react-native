import type {
  AppContext,
  DeviceContext,
  ExpoConstantsContext,
  OsContext,
  OtaContext,
  PionneContexts,
  PionneEvent,
  RuntimeContext,
} from './types';

// ─── Loose type stubs for optional libs we don't want to depend on ─

type RNPlatform = {
  OS: string;
  Version: string | number;
  isPad?: boolean;
  isTV?: boolean;
  constants?: Record<string, unknown>;
};

type RNDimensions = {
  get: (target: 'window' | 'screen') => {
    width: number;
    height: number;
    scale: number;
    fontScale?: number;
  };
};

type ExpoApplicationModule = {
  applicationId?: string | null;
  applicationName?: string | null;
  nativeApplicationVersion?: string | null;
  nativeBuildVersion?: string | null;
};

type ExpoDeviceModule = {
  brand?: string | null;
  manufacturer?: string | null;
  modelName?: string | null;
  modelId?: string | null;
  designName?: string | null;
  productName?: string | null;
  deviceName?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  osBuildId?: string | null;
  osInternalBuildId?: string | null;
  isDevice?: boolean;
  deviceYearClass?: number | null;
  totalMemory?: number | null;
  deviceType?: number; // enum: 0 unknown / 1 phone / 2 tablet / 3 desktop / 4 tv
  DeviceType?: { UNKNOWN: 0; PHONE: 1; TABLET: 2; DESKTOP: 3; TV: 4 };
  supportedCpuArchitectures?: string[] | null;
};

type ExpoUpdatesModule = {
  updateId?: string | null;
  channel?: string | null;
  runtimeVersion?: string | null;
  createdAt?: Date | null;
  isEnabled?: boolean;
  isEmbeddedLaunch?: boolean;
  isEmergencyLaunch?: boolean;
  isUsingEmbeddedAssets?: boolean;
  checkAutomatically?: string;
  launchDuration?: number;
};

type ExpoConstantsModule = {
  default?: ExpoConstantsModule;
  expoConfig?: { version?: string };
  manifest2?: unknown;
  executionEnvironment?: string;
  sessionId?: string;
  statusBarHeight?: number;
  debugMode?: boolean;
  appOwnership?: string;
};

// ─── Literal requires (Metro-friendly). try/catch handles missing libs.

function loadRN(): { Platform: RNPlatform; Dimensions: RNDimensions } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native') as { Platform: RNPlatform; Dimensions: RNDimensions };
  } catch { return null; }
}

function loadDevice(): ExpoDeviceModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-device') as ExpoDeviceModule;
  } catch { return null; }
}

function loadApplication(): ExpoApplicationModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-application') as ExpoApplicationModule;
  } catch { return null; }
}

function loadUpdates(): ExpoUpdatesModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-updates') as ExpoUpdatesModule;
  } catch { return null; }
}

function loadConstants(): ExpoConstantsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-constants') as ExpoConstantsModule;
    // expo-constants exposes everything under `default`; flatten for ergonomics.
    return mod.default ?? mod;
  } catch { return null; }
}

// ─── Helpers ──────────────────────────────────────────────────────

function intl(): { locale?: string; timezone?: string } {
  try {
    const opts = (Intl as unknown as {
      DateTimeFormat: () => { resolvedOptions: () => { locale?: string; timeZone?: string } };
    })
      .DateTimeFormat()
      .resolvedOptions();
    return { locale: opts.locale, timezone: opts.timeZone };
  } catch { return {}; }
}

function deviceTypeName(Device: ExpoDeviceModule | null, dt?: number): DeviceContext['type'] | undefined {
  if (!Device || dt == null) return undefined;
  const map: Record<number, DeviceContext['type']> = {
    0: 'unknown', 1: 'phone', 2: 'tablet', 3: 'desktop', 4: 'tv',
  };
  return map[dt];
}

function detectHermes(): { hermes: boolean; version?: string; debugInfo?: boolean } {
  const g = globalThis as unknown as {
    HermesInternal?: {
      getRuntimeProperties?: () => Record<string, unknown>;
    };
  };
  if (!g.HermesInternal) return { hermes: false };
  let version: string | undefined;
  let debugInfo: boolean | undefined;
  try {
    const props = g.HermesInternal.getRuntimeProperties?.();
    if (props) {
      version = (props['OSS Release Version'] as string) ?? undefined;
      debugInfo = (props['Build'] as string)?.includes('Debug') ?? false;
    }
  } catch { /* noop */ }
  return { hermes: true, version, debugInfo };
}

// =====================================================================

export const SDK_NAME = '@pionne/react-native';
export const SDK_VERSION = '0.9.3';

/**
 * Inspect everything the host app exposes at startup — synchronously — and
 * return both the legacy flat fields (for indexable filtering) and the
 * nested `contexts` object (for full UI display).
 */
export function gatherStaticContext(): Partial<PionneEvent> {
  const out: Partial<PionneEvent> = {};
  const contexts: PionneContexts = {
    sdk: { name: SDK_NAME, version: SDK_VERSION },
  };

  // ─── react-native ─────────────────────────────────────────────
  const RN = loadRN();
  const RNPlatform = RN?.Platform;
  const Dimensions = RN?.Dimensions;
  const osMap: Record<string, string> = { ios: 'iOS', android: 'Android', web: 'Web' };

  const os: OsContext = {};
  if (RNPlatform) {
    os.name = osMap[RNPlatform.OS] ?? RNPlatform.OS;
    os.version = String(RNPlatform.Version ?? '');
    out.os_name = os.name;
    out.os_version = os.version;
  }

  const device: DeviceContext = {};
  if (Dimensions) {
    try {
      const screen = Dimensions.get('screen');
      device.screen_width_pixels = Math.round(screen.width);
      device.screen_height_pixels = Math.round(screen.height);
      device.screen_density = screen.scale;
    } catch { /* noop */ }
  }

  // ─── expo-device ──────────────────────────────────────────────
  const Device = loadDevice();
  if (Device) {
    if (Device.modelName) {
      device.model = Device.modelName;
      out.device_model = Device.modelName;
    }
    if (Device.modelId) device.model_id = Device.modelId;
    if (Device.brand) {
      device.brand = Device.brand;
      out.device_brand = Device.brand;
    }
    if (Device.manufacturer) {
      device.manufacturer = Device.manufacturer;
      out.device_manufacturer = Device.manufacturer;
    }
    if (Device.deviceName) device.name = Device.deviceName;
    if (Device.designName && !device.name) device.name = Device.designName;
    if (typeof Device.deviceYearClass === 'number') device.year_class = Device.deviceYearClass;
    if (typeof Device.totalMemory === 'number') device.memory_size = Device.totalMemory;
    if (Device.supportedCpuArchitectures?.length) device.arch = Device.supportedCpuArchitectures[0];
    if (typeof Device.isDevice === 'boolean') {
      device.simulator = !Device.isDevice;
      out.is_device = Device.isDevice;
    }
    const dt = deviceTypeName(Device, Device.deviceType);
    if (dt) device.type = dt;
    if (RNPlatform?.OS === 'ios') device.family = 'iOS';
    else if (RNPlatform?.OS === 'android') device.family = 'Android';

    if (Device.osBuildId) os.build = Device.osBuildId;
    if (Device.osInternalBuildId && !os.kernel_version) os.kernel_version = Device.osInternalBuildId;
    if (Device.osName && !os.name) os.name = Device.osName;
    if (Device.osVersion && !os.version) os.version = Device.osVersion;
  }

  const ilocale = intl();
  if (ilocale.locale) {
    device.locale = ilocale.locale;
    out.locale = ilocale.locale;
  }
  if (ilocale.timezone) {
    device.timezone = ilocale.timezone;
    out.timezone = ilocale.timezone;
  }

  if (Object.keys(device).length) contexts.device = device;
  if (Object.keys(os).length) contexts.os = os;

  // ─── expo-application ─────────────────────────────────────────
  const App = loadApplication();
  const app: AppContext = {};
  if (App) {
    if (App.applicationName) app.name = App.applicationName;
    if (App.applicationId) {
      app.bundle_id = App.applicationId;
      out.app_id = App.applicationId;
    }
    if (App.nativeApplicationVersion) {
      app.version = App.nativeApplicationVersion;
      out.app_version = App.nativeApplicationVersion;
    }
    if (App.nativeBuildVersion) {
      app.build = App.nativeBuildVersion;
      out.app_build = App.nativeBuildVersion;
    }
  }
  if (Object.keys(app).length) contexts.app = app;

  // ─── expo-updates ─────────────────────────────────────────────
  const Updates = loadUpdates();
  if (Updates) {
    const ota: OtaContext = {};
    if (Updates.updateId) {
      ota.update_id = Updates.updateId;
      out.ota_update_id = Updates.updateId;
    }
    if (Updates.channel) {
      ota.channel = Updates.channel;
      out.ota_channel = Updates.channel;
    }
    if (Updates.runtimeVersion) {
      ota.runtime_version = Updates.runtimeVersion;
      out.runtime_version = Updates.runtimeVersion;
    }
    if (typeof Updates.isEnabled === 'boolean') ota.is_enabled = Updates.isEnabled;
    if (typeof Updates.isEmbeddedLaunch === 'boolean') ota.is_embedded_launch = Updates.isEmbeddedLaunch;
    if (typeof Updates.isEmergencyLaunch === 'boolean') ota.is_emergency_launch = Updates.isEmergencyLaunch;
    if (typeof Updates.isUsingEmbeddedAssets === 'boolean') ota.is_using_embedded_assets = Updates.isUsingEmbeddedAssets;
    if (Updates.checkAutomatically) ota.check_automatically = Updates.checkAutomatically;
    if (typeof Updates.launchDuration === 'number') ota.launch_duration = Updates.launchDuration;
    if (Updates.createdAt) ota.created_at = new Date(Updates.createdAt as unknown as string).toISOString();
    if (Object.keys(ota).length) contexts.ota = ota;
  }

  // ─── expo-constants ───────────────────────────────────────────
  const Constants = loadConstants();
  if (Constants) {
    const ec: ExpoConstantsContext = {};
    if (typeof Constants.debugMode === 'boolean') ec.debug_mode = Constants.debugMode;
    if (Constants.executionEnvironment) ec.execution_environment = Constants.executionEnvironment;
    if (Constants.sessionId) ec.session_id = Constants.sessionId;
    if (typeof Constants.statusBarHeight === 'number') ec.status_bar_height = Constants.statusBarHeight;
    if (Constants.appOwnership) ec.app_ownership = Constants.appOwnership;
    if (Object.keys(ec).length) contexts.expo_constants = ec;
  }

  // ─── runtime ──────────────────────────────────────────────────
  const runtime: RuntimeContext = { name: 'react-native', expo: !!Constants };
  const hermes = detectHermes();
  runtime.hermes = hermes.hermes;
  runtime.js_engine = hermes.hermes ? 'hermes' : 'jsc';
  if (hermes.version) runtime.hermes_version = hermes.version;
  if (typeof hermes.debugInfo === 'boolean') runtime.hermes_debug_info = hermes.debugInfo;

  // Detect Fabric & TurboModule via global flags exposed by the new arch.
  const g = globalThis as Record<string, unknown>;
  if (typeof g.RN$Bridgeless === 'boolean') runtime.fabric = g.RN$Bridgeless as boolean;
  if (typeof g.__turboModuleProxy !== 'undefined') runtime.turbo_module = true;

  // react-native version: leave it to be filled by the host app via tags or
  // by expo-constants (`expoConfig.sdkVersion` or similar). Pulling the full
  // package.json at build time bloats the bundle ~10x.

  contexts.runtime = runtime;

  out.contexts = contexts;
  return out;
}
