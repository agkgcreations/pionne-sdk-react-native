// Native crash bridge.
//
// JS-only error handlers (ErrorUtils, promise rejection tracker, Error
// Boundary) can NEVER see a native crash: when the Objective-C/Swift or
// JVM/NDK side dies, the whole process — including the JS VM — is gone before
// any JS runs. So we lean on the OS:
//   - iOS 14+    : MetricKit (MXCrashDiagnostic), delivered on the next launch
//   - Android 11+: ActivityManager.getHistoricalProcessExitReasons()
//
// The native module persists these and we drain them here on init(), turning
// each into a `fatal` event with mechanism.type = 'native'.
//
// Best-effort and never blocking: the native module is absent from Expo Go,
// the web target, and any build made before the SDK shipped native code — in
// all those cases every function here silently no-ops.

/** One past-process death the OS attributed to a crash/abnormal exit. */
export interface NativeCrashRecord {
  platform: 'ios' | 'android';
  /** Short type label, e.g. "EXC_BAD_ACCESS (SIGSEGV)" or "REASON_CRASH_NATIVE". */
  type: string;
  /** Human-readable reason / OS description. */
  message: string;
  /** Epoch milliseconds of the crash (previous run). */
  timestamp: number;
  /** Best-effort frames. Native app frames are unsymbolicated (no dSYM step). */
  stack: string[];
  /** App version that was running when it crashed (may differ from current). */
  appVersion?: string;
  /** OS version at crash time. */
  osVersion?: string;
}

interface PionneNativeModule {
  /**
   * Returns the crashes the OS recorded since the last call and marks them as
   * drained (iOS clears the stored payloads; Android advances its high-water
   * timestamp), so a given crash is reported exactly once.
   */
  getPendingNativeCrashes(): Promise<NativeCrashRecord[]>;
}

// `undefined` = not resolved yet, `null` = resolved and unavailable.
let nativeModule: PionneNativeModule | null | undefined;

function getNativeModule(): PionneNativeModule | null {
  if (nativeModule !== undefined) return nativeModule;
  try {
    // expo-modules-core is a transitive dep of expo-application/device/updates
    // (the SDK's peer deps). `requireOptionalNativeModule` returns null —
    // instead of throwing — when the native side isn't linked (Expo Go).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: (name: string) => unknown;
    };
    const mod = core.requireOptionalNativeModule?.('PionneNative') ?? null;
    nativeModule = (mod as PionneNativeModule | null) ?? null;
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

/**
 * Drain the OS-recorded native crashes from the previous run(s). Resolves to
 * an empty array (never rejects) when the native module is unavailable or any
 * step fails — a monitoring SDK must never throw into the host's init path.
 */
export async function getPendingNativeCrashes(): Promise<NativeCrashRecord[]> {
  const mod = getNativeModule();
  if (!mod?.getPendingNativeCrashes) return [];
  try {
    const records = await mod.getPendingNativeCrashes();
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}
