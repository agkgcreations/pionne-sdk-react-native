# @pionne/react-native

Mobile-first error monitoring SDK for React Native + Expo.

Three lines to capture every JS error and read symbolicated stacks straight from production.

- 🪶 **~22 KB** bundled, zero runtime dependency
- 🛜 Works with **Expo, bare RN, Hermes & JSC**
- 🎯 Auto-capture: JS exceptions, unhandled rejections, throws inside `setTimeout`
- 💥 **Native crashes** (iOS MetricKit / Android ApplicationExitInfo) replayed on the next launch
- 🔌 Manual: `captureException` / `captureMessage` / `wrap` / `<PionneErrorBoundary>`
- 🍞 **Auto breadcrumbs** (console + fetch) attached to every event
- 📸 **Screenshot** opt-in attached to each error
- 🗺️ **Source maps** resolved server-side (readable stacks in prod)
- 🔒 **Bundle ID auto-pinning** anti-token-theft
- 🛡️ **PII scrubber** on by default (email, card, IBAN, JWT, IP, tokens)
- 🎚️ **Sample rate** anti-flood
- 🪝 `beforeSend` for custom scrubbing

## Install

```bash
npm install @pionne/react-native
```

Optional (peer deps):

```bash
npx expo install expo-application expo-device expo-updates expo-constants
npx expo install react-native-view-shot          # for screenshots
npx expo install @react-native-async-storage/async-storage  # for the offline queue
```

## Get your token

Pionne is mobile-first: you generate and view your errors **from the Pionne mobile app**, not from a web dashboard that scrolls poorly on phone.

1. **Download the Pionne app**:
   - 🍎 [App Store](https://apps.apple.com/app/id6766753270) *(coming soon)*
   - [<img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Get it on Google Play" height="40"/>](https://play.google.com/store/apps/details?id=fr.agkgcreations.pionne)
2. Create your account (30 days free, no card required)
3. **+ New project** → pick your platform → copy the token displayed in big (starts with `pio_live_…`)
4. Paste it into your app via `Pionne.init({ token })` (see below)

⚠️ The token is shown **only once** at creation — store it in an environment variable (`EXPO_PUBLIC_PIONNE_TOKEN`) or directly in `app.json` → `extra.pionneToken`.

## Skip the SDK in dev

To stop polluting your prod dashboard with the events you generate in Metro / Expo Go (and dodge the bundle-ID-mismatch headache), pass `enableInDev: false`:

```ts
Pionne.init({
  token: 'pio_live_…',
  enableInDev: false, // no-op in __DEV__
});
```

In `__DEV__`, `init()` logs `[Pionne] Skipped in __DEV__ (enableInDev=false)` and every method (`captureException`, `captureMessage`, `setUser`, etc.) becomes a silent no-op for the lifetime of the process. No global handler installed, no session opened. Default: `enableInDev: true` (backwards compatible).

## Quickstart

```ts
import { Pionne } from '@pionne/react-native';

Pionne.init({
  token: 'pio_live_xxx',     // from the Pionne mobile app
  release: '1.0.0',
  environment: 'production',
});
```

That's it. Every JS exception and unhandled promise gets shipped to the Pionne dashboard, deduplicated by fingerprint, with stack trace, OS, device model and app version.

## Setup auto-upload sourcemaps

One command — configures EAS Secrets and writes the EAS Build hook:

```bash
npx @pionne/react-native setup
```

On every `eas build`, the `.map` files upload themselves. In production your stack traces show up as `App.tsx:42 (CheckoutScreen)` instead of `bundle:3:18745`.

> **Note (≥ 0.8.2):** sourcemaps are gzipped before upload (~10× smaller). Works with shared hosts that have a low Apache `LimitRequestBody` (O2switch, etc.). The Pionne server detects the compressed format automatically.

## API

```ts
// Init with every option
Pionne.init({
  token: 'pio_live_xxx',
  release: '1.0.0',
  environment: 'production',
  tags: { plan: 'pro' },
  scrubPii: true,                // default true
  sampleRate: 1.0,               // default 1
  captureScreenshot: false,      // default false
  breadcrumbs: true,             // default true
  beforeSend: (event) => event,
  // ...
});

// Manual
Pionne.captureException(err, { tags: { feature: 'checkout' } });
Pionne.captureMessage('User reached the empty state', { level: 'info' });

// Wrap async/sync — captures + re-throws automatically
const submit = Pionne.wrap(async () => {
  await api.post('/order');
});

// Manual breadcrumbs (on top of the auto-instrumentation)
Pionne.addBreadcrumb({ category: 'ui', message: 'tap "checkout"' });

// Identify a user
Pionne.setUser('anon_a1b2c3');     // any opaque id
Pionne.setUser(null);               // logout

// Tags
Pionne.setTags({ plan: 'pro' });

// Toggle reporting at runtime
Pionne.setEnabled(false);
```

## React Error Boundary

Captures React render errors (which `ErrorUtils` doesn't see):

```tsx
import { PionneErrorBoundary } from '@pionne/react-native';

<PionneErrorBoundary
  fallback={({ error, reset }) => (
    <View>
      <Text>Something crashed: {error.message}</Text>
      <Button onPress={reset} title="Try again" />
    </View>
  )}
>
  <App />
</PionneErrorBoundary>
```

## Screenshots

```tsx
import { useRef, useEffect } from 'react';
import { View } from 'react-native';
import { Pionne } from '@pionne/react-native';

Pionne.init({ token, captureScreenshot: true });

export default function App() {
  const root = useRef(null);
  useEffect(() => Pionne.setRootRef(root), []);
  return <View ref={root} collapsable={false}>{/* … */}</View>;
}
```

On every error, a JPG (quality 0.5) of the root view is attached. Visible in the "Capture" tab of the issue detail.

## Native crashes

JS handlers **never** see a native crash: the whole process dies before any JS runs. Pionne leans on the OS to record them and replays each as a `fatal` event (`mechanism.type = "native"`) on the **next launch**.

```ts
Pionne.init({ token, captureNativeCrashes: true }); // default: true
```

**What's captured on iOS 14+** via MetricKit:

- `NSException` Obj-C/Swift (name + composed message on iOS 17+, e.g. `NSInvalidArgumentException`)
- Signals: `SIGSEGV`, `SIGABRT`, `SIGBUS`, `SIGILL`, `SIGFPE`, `SIGTRAP`
- Out-of-memory kills and watchdog terminations (`0x8badf00d`)
- Call stack tree (system frames symbolicated by the OS; app frames as `binaryName 0xADDR`)

**What's captured on Android 11+** via `ApplicationExitInfo`:

- `REASON_CRASH` — unhandled JVM exception
- `REASON_CRASH_NATIVE` — NDK / native (C/C++) crash
- `REASON_ANR` — Application Not Responding (with the ANR trace)
- `REASON_LOW_MEMORY` — OOM kill

> ⚠️ Requires a **development build** or a **production build** (`expo prebuild` / EAS Build) — the native module is absent from Expo Go, where the option silently no-ops (no crash). After install, run `npx expo prebuild` (or `pod install`) so the module is linked. iOS deployment target ≥ 13.4. Tag `native.source` = `metrickit` (iOS) or `app_exit` (Android).

## CLI

```bash
# Interactive wizard: configures EAS Secrets + writes the hook
npx @pionne/react-native setup

# Upload sourcemaps in CI/EAS
npx @pionne/react-native upload-sourcemaps --platform ios

# Help
npx @pionne/react-native --help
```

## Profiling (Hermes only)

Manually profile critical screens / transactions to view a **flame graph** in the mobile dashboard and detect perf regressions across releases.

```ts
// Wrap an entire transaction
await Pionne.profile('CheckoutFlow', async () => {
  await fetchCart();
  await applyDiscount();
  await submitOrder();
}, { route: '/checkout' });

// Or start/stop manually
Pionne.startProfile('HomeScreenMount', { route: '/home' });
// … your render path …
await Pionne.stopProfile();
```

The SDK uses Hermes' native sampler (`HermesInternal.dumpSampledTrace`) — ~1–3% CPU overhead during capture, **zero overhead when idle**. JSC has no sampling support: the function returns `false` silently (with a `console.info` in dev so you notice).

Samples are POSTed to `/api/profiles` (rate-limit shared with `/ingest`). Format: raw Chrome Trace Event Format, aggregated server-side into P50/P95/P99 per function for the flame graph + cross-release diff.

Full API:

| Method | Role |
|---|---|
| `Pionne.startProfile(name, meta?)` | Start a capture. Idempotent for the same `name`. |
| `Pionne.stopProfile()` → `Promise<id \| null>` | Stop + upload, returns the server-side ID. |
| `Pionne.profile(name, fn, meta?)` | Sugar — wraps a fn or Promise. |

`meta` accepts `{ route?: string, eventId?: number }` — `eventId` ties the profile to a specific crash event for drill-down.

## Options

| Option | Default | Description |
|---|---|---|
| `token` | required | `pio_live_…` (from the Pionne app) |
| `endpoint` | `https://pionne.agkgcreations.fr/api/ingest` | API URL |
| `release` | auto (`expo.version`) | App release used to group regressions |
| `environment` | `__DEV__ ? 'development' : 'production'` | Environment label |
| `enabled` | `true` | Toggle reporting |
| `enableInDev` | `true` | Set to `false` to make `init()` a no-op in `__DEV__`. Recommended to avoid polluting your prod dashboard with Expo Go / Metro events. |
| `captureUncaughtErrors` | `true` | ErrorUtils + timer wrapping |
| `captureUnhandledRejections` | `true` | Hermes rejection tracker |
| `captureNativeCrashes` | `true` | Native crashes (iOS MetricKit / Android ApplicationExitInfo), replayed on the next launch. Requires a dev/prod build (no-op in Expo Go). |
| `breadcrumbs` | `true` | Auto-instrument console + fetch |
| `scrubPii` | `true` | Scrub email/card/IBAN/JWT/IP/tokens |
| `sampleRate` | `1` | Drop ratio (0..1) |
| `captureScreenshot` | `false` | JPG of the root view on every error |
| `screenshotQuality` | `0.5` | JPEG quality (0..1) |
| `tags` | — | Tags merged into every event |
| `userIdAnon` | — | Anonymous id (not an email) |
| `appId` | auto | Bundle ID (anti-token-theft) |
| `beforeSend` | — | Hook before sending (return `null` to drop) |
| `maxStackFrames` | `50` | Frames sent per event |
| `maxEventsPerSecond` | `10` | Client-side token bucket. Above the cap, silent drop. `0` disables (not recommended). The server has its own per-token rate limit, independent. |
| `releaseHealth` | `true` | Opens a session at `init()` to compute crash-free user rate. |
| `sendGeography` | `false` | Opt-in: attaches `contexts.geo` (city / region / country) resolved IP-side. |

## Subscription

30-day trial, no card required. Pricing and subscription happen in the Pionne mobile app (App Store / Play Store).

[Full docs](https://pionne.agkgcreations.fr/quickstart)

## Changelog

- **0.9.3** — All in-source code comments + JSDoc translated to English (the public-API JSDoc in `types.ts` ships in the `.d.ts` so this surfaces in IDE autocomplete). One stray French comment in `android/build.gradle` cleaned up. No API or behaviour change vs 0.9.2.
- **0.9.2** — README fully translated to English (the 0.9.0 native-crash sections and several pre-existing pieces still had French copy). No API or behaviour change vs 0.9.1.
- **0.9.1** — Fix launch crash on **iOS 26 + new architecture** (RN [#54859](https://github.com/facebook/react-native/issues/54859)): on this exact combo RN re-throws the captured error via a void TurboModule from an async dispatch queue → uncatchable `SIGABRT`. The SDK detects the affected surface (prod + iOS 26+ + new-arch) and suspends `originalErrorHandler` after capturing the event — log + return instead of crashing the host app. No change on any other environment. On Android, added `versionCode` / `versionName` required by Expo SDK 56 autolinking.
- **0.9.0** — **Native crash capture**: MetricKit (iOS 14+) + ApplicationExitInfo (Android 11+), replayed as `fatal` events (`mechanism.type=native`) on the next launch. The SDK now ships an Expo native module → requires `expo prebuild` + a dev/prod build (no-op in Expo Go). New option `captureNativeCrashes` (default `true`). Aligns `SDK_VERSION` with the package version.
- **0.8.7** — `pionne setup`: the pre-check finally detects EAS variables already configured (the parser expected a space after the name, while `eas env:list --format short` outputs `NAME=value`). The wizard always reported "fresh install" and silently re-created the 9 entries on every run. CLI-only fix.
- **0.8.6** — Permanent rejection (401/403/422): enriched error message client-side. The `console.warn` (logged once per session, even in prod / TestFlight) parses the JSON response, distinguishes the cases (Bundle ID mismatch / token rejected / 422 validation), shows the `app_id` actually sent + the masked `expected_format` returned by the server, and gives an actionable next step. No breaking change.
- **0.8.5** — `enableInDev` option to make `init()` a no-op in `__DEV__`.
- **0.8.2** — CLI: sourcemaps gzipped automatically before upload (~10× smaller). Passes low Apache `LimitRequestBody` on shared hosts (O2switch, etc.). The Pionne server decodes the compressed format transparently.
- **0.8.0** — Hermes profiling: `Pionne.startProfile / stopProfile / profile`.
- **0.7.x** — Bilingual CLI (en/fr), project auto-pick via `app.json:expo.name`, pre-check of EAS env vars.
- **0.5.0** — Release Health (sessions, crash-free user rate), feedback widget, IP-side geo.

## License

MIT © AGKG Creations
