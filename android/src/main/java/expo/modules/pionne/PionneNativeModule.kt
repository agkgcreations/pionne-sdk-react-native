package expo.modules.pionne

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Native crash capture for Android via ActivityManager.getHistoricalProcessExitReasons()
// (API 30 / Android 11+). Unlike iOS MetricKit, this is a *pull* API: it returns
// the full exit history on every call, so we persist a high-water timestamp in
// SharedPreferences and only surface exits newer than the last reported one —
// each crash is reported exactly once. No runtime permission required.
class PionneNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PionneNative")

    AsyncFunction("getPendingNativeCrashes") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        collectPendingCrashes()
      } else {
        emptyList<Map<String, Any?>>()
      }
    }
  }

  private val prefs
    get() = appContext.reactContext?.getSharedPreferences("pionne_native", Context.MODE_PRIVATE)

  @RequiresApi(Build.VERSION_CODES.R)
  private fun collectPendingCrashes(): List<Map<String, Any?>> {
    val context = appContext.reactContext ?: return emptyList()
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      ?: return emptyList()

    val infos = try {
      am.getHistoricalProcessExitReasons(context.packageName, 0, 0)
    } catch (e: Throwable) {
      return emptyList()
    }

    val store = prefs
    val lastReported = store?.getLong(KEY_LAST_TS, 0L) ?: 0L
    var maxTs = lastReported
    val out = mutableListOf<Map<String, Any?>>()

    for (info in infos) {
      if (info.timestamp <= lastReported) continue
      if (!isCrashReason(info.reason)) continue
      if (info.timestamp > maxTs) maxTs = info.timestamp
      out.add(mapExit(info))
    }

    if (maxTs > lastReported) {
      store?.edit()?.putLong(KEY_LAST_TS, maxTs)?.apply()
    }
    return out
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun isCrashReason(reason: Int): Boolean = when (reason) {
    ApplicationExitInfo.REASON_CRASH,         // unhandled JVM exception
    ApplicationExitInfo.REASON_CRASH_NATIVE,  // native (NDK) crash
    ApplicationExitInfo.REASON_ANR,           // app not responding
    ApplicationExitInfo.REASON_LOW_MEMORY -> true // OOM kill
    else -> false
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_CRASH -> "REASON_CRASH"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "REASON_CRASH_NATIVE"
    ApplicationExitInfo.REASON_ANR -> "REASON_ANR"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "REASON_LOW_MEMORY"
    else -> "REASON_$reason"
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun mapExit(info: ApplicationExitInfo): Map<String, Any?> {
    val stack = mutableListOf<String>()
    // ANR traces are plain text; native tombstones are protobuf, so only read
    // the trace for ANRs (where it is human-readable).
    if (info.reason == ApplicationExitInfo.REASON_ANR) {
      try {
        info.traceInputStream?.bufferedReader()?.useLines { lines ->
          lines.take(100).forEach { stack.add(it) }
        }
      } catch (_: Throwable) {
      }
    }
    return mapOf(
      "platform" to "android",
      "type" to reasonName(info.reason),
      "message" to (info.description ?: reasonName(info.reason)),
      "timestamp" to info.timestamp,
      "stack" to stack,
      "appVersion" to null,
      "osVersion" to Build.VERSION.RELEASE,
    )
  }

  companion object {
    private const val KEY_LAST_TS = "last_reported_ts"
  }
}
