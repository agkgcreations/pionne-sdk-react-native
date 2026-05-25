import ExpoModulesCore
import Foundation
import MetricKit

// Native crash capture for iOS via MetricKit.
//
// JS error handlers can't see a native crash — the process (and the JS VM)
// is gone before any JS runs. MetricKit (iOS 14+) records crash diagnostics
// and delivers them to a subscriber on the *next* launch, a few seconds in.
// We persist them to UserDefaults on receipt and let JS drain them via
// getPendingNativeCrashes() (clears on read → each crash reported once).
public class PionneNativeModule: Module {
  private let subscriber = PionneMetricSubscriber()

  public func definition() -> ModuleDefinition {
    Name("PionneNative")

    OnCreate {
      if #available(iOS 14.0, *) {
        MXMetricManager.shared.add(self.subscriber)
      }
    }

    OnDestroy {
      if #available(iOS 14.0, *) {
        MXMetricManager.shared.remove(self.subscriber)
      }
    }

    // Returns the crashes stored since the last call, then clears them.
    AsyncFunction("getPendingNativeCrashes") { () -> [[String: Any]] in
      PionneCrashStore.drain()
    }
  }
}

final class PionneMetricSubscriber: NSObject, MXMetricManagerSubscriber {
  // Performance metrics payload — not used here.
  func didReceive(_ payloads: [MXMetricPayload]) {}

  // Diagnostics payload (crashes, hangs, disk-writes…) — iOS 14+.
  @available(iOS 14.0, *)
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    var records: [[String: Any]] = []
    for payload in payloads {
      let crashTime = Int(payload.timeStampEnd.timeIntervalSince1970 * 1000)
      guard let crashes = payload.crashDiagnostics else { continue }
      for crash in crashes {
        records.append(PionneCrashMapper.map(crash, timestamp: crashTime))
      }
    }
    if !records.isEmpty {
      PionneCrashStore.append(records)
    }
  }
}

// MARK: - Persistence

enum PionneCrashStore {
  private static let key = "pionne.native.crashes"
  private static let queue = DispatchQueue(label: "fr.pionne.crashstore")

  static func append(_ records: [[String: Any]]) {
    queue.sync {
      var existing = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
      existing.append(contentsOf: records)
      // Cap so a host that never drains can't grow this unbounded.
      if existing.count > 50 { existing = Array(existing.suffix(50)) }
      UserDefaults.standard.set(existing, forKey: key)
    }
  }

  static func drain() -> [[String: Any]] {
    queue.sync {
      let existing = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
      UserDefaults.standard.removeObject(forKey: key)
      return existing
    }
  }
}

// MARK: - Mapping

@available(iOS 14.0, *)
enum PionneCrashMapper {
  static func map(_ crash: MXCrashDiagnostic, timestamp: Int) -> [String: Any] {
    let meta = crash.metaData

    var typeParts: [String] = []
    if let signal = crash.signal {
      typeParts.append(signalName(signal.int32Value))
    }
    if let excType = crash.exceptionType {
      typeParts.append("EXC(\(excType.intValue))")
    }
    var type = typeParts.isEmpty ? "NativeCrash" : typeParts.joined(separator: " ")

    var messageParts: [String] = []
    if let reason = crash.terminationReason, !reason.isEmpty {
      messageParts.append(reason)
    }

    // iOS 17+: structured Objective-C exception (e.g. NSInvalidArgumentException).
    if #available(iOS 17.0, *), let objc = crash.exceptionReason {
      type = objc.exceptionType
      messageParts.insert(objc.composedMessage, at: 0)
    }

    if let code = crash.exceptionCode {
      messageParts.append("code \(code.intValue)")
    }
    let message = messageParts.isEmpty ? "Native crash" : messageParts.joined(separator: " · ")

    return [
      "platform": "ios",
      "type": type,
      "message": message,
      "timestamp": timestamp,
      "stack": flattenCallStack(crash.callStackTree),
      "appVersion": meta.applicationBuildVersion,
      "osVersion": meta.osVersion,
    ]
  }

  static func signalName(_ signal: Int32) -> String {
    switch signal {
    case SIGSEGV: return "SIGSEGV"
    case SIGABRT: return "SIGABRT"
    case SIGBUS: return "SIGBUS"
    case SIGILL: return "SIGILL"
    case SIGFPE: return "SIGFPE"
    case SIGTRAP: return "SIGTRAP"
    case SIGKILL: return "SIGKILL"
    default: return "signal \(signal)"
    }
  }

  static func flattenCallStack(_ tree: MXCallStackTree) -> [String] {
    guard
      let obj = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()),
      let json = obj as? [String: Any],
      let callStacks = json["callStacks"] as? [[String: Any]]
    else { return [] }

    var frames: [String] = []
    for stack in callStacks {
      if let roots = stack["callStackRootFrames"] as? [[String: Any]] {
        walk(roots, into: &frames)
      }
      if frames.count >= 100 { break }
    }
    return Array(frames.prefix(100))
  }

  private static func walk(_ nodes: [[String: Any]], into frames: inout [String]) {
    for node in nodes {
      if frames.count >= 100 { return }
      let binary = node["binaryName"] as? String ?? "?"
      let address = (node["address"] as? NSNumber)?.uint64Value ?? 0
      frames.append(String(format: "%@ 0x%llx", binary, address))
      if let sub = node["subFrames"] as? [[String: Any]] {
        walk(sub, into: &frames)
      }
    }
  }
}
