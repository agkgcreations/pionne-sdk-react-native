# Changelog

## 0.8.7 — 2026-05-12

### Fixed

- **`pionne setup` now detects already-configured EAS variables.** The
  pre-flight check ran `eas env:list --format short`, whose output is
  `NAME=value` per line (and `NAME=***** (secret)` for secret vars), but
  the matcher expected whitespace after the variable name — so it never
  matched. Result: the wizard always announced "No existing PIONNE_*
  variables — fresh install", never showed the "Overwrite? (y/N)"
  prompt, and silently re-created all 9 entries on every run. The regex
  now accepts `=`, whitespace, or end-of-line after the name, so it
  works for both the `short` and `long` (table) output formats.

## 0.8.6 — 2026-05-10

### Changed

- **Actionable error on permanent ingest rejection (401/403/422).**
  `doSend()` now parses the JSON error envelope, distinguishes the
  failure modes (Bundle ID mismatch / token rejected / 422 validation),
  and emits a single `console.warn` (once per session, in prod too —
  e.g. TestFlight) that includes the `app_id` the SDK actually sent, the
  masked `expected_format` returned by the server, and a clear pointer
  to where to fix it. Resolves the silent-rejection footgun. No breaking
  change.

## 0.8.5 — 2026-05-09

### Added

- **`enableInDev?: boolean` option.** Default `true` (backward compat).
  Pass `false` to make `Pionne.init()` no-op when the host runs under
  `__DEV__` (Metro / Expo Go / dev build). Avoids polluting your prod
  dashboard with debug noise and dodges the bundle ID mismatch
  headache between Expo Go's `host.exp.Exponent` and the bundle pinned
  on your project.

  ```ts
  Pionne.init({
    token: 'pio_live_…',
    enableInDev: false, // silence everything in __DEV__
  });
  ```

  When skipped, no global handlers are installed, no session opens, no
  geo lookup runs. All `Pionne.captureXxx()` calls also no-op silently
  for the lifetime of the process. A single `console.info` is emitted
  on init so you know the SDK is intentionally dormant.

## 0.8.4 — 2026-05-09

### Fixed

- **Release Health no longer reports phantom crashes.** Previously, when
  the global error handler caught an uncaught exception, it called
  `send(event)` and `flipFromEvent(event)` back-to-back. `send` is
  fire-and-forget — if the POST `/api/ingest` was rejected (bundle ID
  mismatch, token revoked, network error, validation), the session was
  still flipped to `crashed`/`errored` server-side. Result: the
  dashboard showed "1 crash · 2 errors" on a release, but the Issues
  tab was empty because no event was ever persisted.
  The fix turns `send` into `Promise<boolean>` and only flips the
  session if the event actually landed (HTTP 2xx). Manual captures
  (`captureException`, `captureMessage`) still don't touch session
  health (Sentry parity). On bundle mismatch, the dev still sees the
  "[Pionne] event rejected (permanent)" warning so they can fix the
  config — they just no longer get a misleading session marker.

## 0.8.1 — 2026-05-09

### Documentation

- README clarifié : retire les valeurs internes précises sur les caps
  serveur (rate-limit, payload size, retention) et remplace par des
  formulations vagues. Ces détails restent applicables côté infra
  mais ne sont plus exposés sur npm. Aucun changement de code SDK.

## 0.8.0 — 2026-05-09

### Added

- **Profiling (Hermes only).** Manual transaction-scoped CPU profiling
  via `Pionne.startProfile(name, meta?)` / `Pionne.stopProfile()` and
  the sugar `Pionne.profile(name, fn, meta?)`. Wraps Hermes' built-in
  `enableSamplingProfiler` / `dumpSampledTrace` and ships the resulting
  Chrome Trace Event blob to the new `POST /api/profiles` endpoint.
  - **Overhead** : ~1–3 % CPU during capture, **zero when idle**.
  - **JSC** : the API silently no-ops (returns false on start, null on
    stop) — your app code doesn't need a runtime-engine check.
  - **Server-side** : raw samples kept 7 days, aggregated nightly into
    P50/P95/P99 per function × release (kept 90 days for cross-release
    regression detection in the dashboard's flame graph view).
  - Backend caps : 100k profiles/day/project, 8 MB max payload, shared
    rate-limit bucket with `/ingest` (600 req/min/token).
  - New types exported: `ProfileMeta`, `ProfilePayload`.

## 0.7.7 — 2026-05-08

### Documentation

- README enrichi : nouveau bloc "Rate limit serveur" qui documente le cap
  600 req/min/token côté API Pionne (ajout backend du même jour). Tableau
  des options complété avec `maxEventsPerSecond`, `releaseHealth`,
  `sendGeography`. Aucun changement de code SDK.

## 0.7.6 — 2026-05-08

### Improved

- **`pionne setup` now explains EAS errors clearly.** When `eas env:create`
  fails because no EAS project is linked to the local app (`extra.eas.projectId`
  missing in `app.json`), the wizard now stops *before* hitting eas-cli and
  prints a fr/en message naming the real cause + the exact fix
  (`eas init` → re-run setup). It also parses post-failure stderr to detect
  three common cases — no EAS project, not logged in, plan quota reached —
  and prints a tailored hint instead of the previous opaque
  `eas env:create … failed`. Resolves the case where devs saw
  `Error: env:create command failed.` with no clue that the underlying
  reason was that the project didn't exist on Expo yet.

## 0.7.5 — 2026-05-08

### Added

- **Geography context** (opt-in). New `sendGeography: true` option on
  `init()` resolves the user's approximate city / region / country /
  country_code via a free IP-based lookup (`https://ipapi.co/json/` by
  default) and attaches it to every event as `contexts.geo`. No GPS, no
  permission, no PII beyond what the IP already reveals. Resolved once
  per process and cached. Customize via `sendGeography: { endpoint?, resolve? }`
  to point at your own service or a server-side proxy.

### Server-side change (no SDK action required)

- **Per-token rate limit on ingest API** : the Pionne backend now caps
  every public endpoint authenticated by `X-Pionne-Token` at **600 req/min
  per token** (= 10 req/sec, shared between `/ingest`, `/sessions`,
  `/feedback`). A leaked token can no longer drain your monthly quota
  nor flood the infrastructure. Excess requests get `HTTP 429` with a
  `Retry-After` header — the SDK fails silently in that case. Aligns
  with the default client-side `maxEventsPerSecond: 10`. See
  [Rate limits doc](https://pionne.agkgcreations.fr/security/rate-limits).

## 0.7.4 — 2026-05-08

### Fixed

- `setup` wizard : password masking finally fixed for real on Node 22+/24
  + macOS zsh. The 0.7.3 attempt (`stty -echo` + `setRawMode(true)`)
  still leaked the typed char because **the parent `readline.Interface`
  remained attached to stdin** (just paused) and re-echoed under the
  hood. Solution : fully `rl.close()` BEFORE the password prompt and
  re-create a fresh interface AFTER. Now stdin is exclusively owned by
  our raw-mode handler during the password input — only `••••••` is
  emitted, never the actual character.

## 0.7.3 — 2026-05-08

### Fixed

- `setup` wizard : password masking ré-régressait sous Node 22+/24 sur
  macOS zsh quand une `readline.Interface` avait déjà été active dans le
  process. `setRawMode(true)` seul ne suffit pas dans ce cas — l'OS
  continuait à echo le caractère APRÈS notre `•`, donnant un affichage
  entrelacé `@•A•n•d•...`. Fix : on combine `setRawMode(true)` avec
  `stty -echo` (POSIX shell) qui désactive l'écho au niveau OS, et on
  restaure les deux à la sortie. Plus aucun caractère du mot de passe
  n'apparaît visuellement.

## 0.7.2 — 2026-05-08

### Security

- **HTTPS-only endpoint enforcement.** `init()` refuse maintenant un
  endpoint non-HTTPS en production (sauf `localhost`/`*.local`). Évite
  toute fuite en clair d'un payload de crash qui contiendrait par
  inadvertance des données sensibles.
- **Token validation renforcée.** Doit faire ≥ 16 caractères après le
  préfixe `pio_live_`, et rejette les placeholders dev (`xxx`, `todo`,
  `changeme`...).
- **Rate limit côté client.** Token-bucket de 10 events/sec par défaut
  (option `maxEventsPerSecond`). Drop silencieux au-delà — protège la
  host d'un runaway loop et plafonne l'impact sur ton quota Pionne.
- **`init()` enveloppé dans un try/catch** : un bug dans le SDK ne crash
  jamais l'app hôte, juste un warning en dev.

## 0.7.1 — 2026-05-07

### Changed

- `setup` wizard now sends `X-Pionne-Client: cli` on `/auth/login` so the
  Pionne API names the issued Sanctum token `cli` and revokes any prior
  CLI token for the same user. Keeps the `personal_access_tokens` table
  tidy across repeated wizard runs and limits blast radius if a CLI
  token leaks.

## 0.7.0 — 2026-05-07

### Added

- **Release Health.** `Pionne.init()` now opens a release session at boot
  (`status='ok'`) and auto-flips it to `crashed`/`errored` whenever the
  global error handler or promise rejection handler sees an uncaught
  fatal/error. The dashboard derives the crash-free user rate per release
  from these sessions. Disable with `releaseHealth: false`.
  - New API: `Pionne.endSession()`, `Pionne.getSessionId()`.
  - New endpoint hit: `POST /api/sessions` (idempotent on `session_id`).
- **User Feedback.** New `<PionneFeedbackModal>` component you mount once
  near your root, plus three programmatic APIs:
  - `Pionne.showFeedback({ eventId? })` — opens the modal
  - `Pionne.captureFeedback({ message, name?, email?, eventId? })` — sends
    a payload directly without UI
  - `Pionne.getFeedbackContext()` — returns the wired-up `{endpoint, token}`
    so power users can roll their own UI
  - New endpoints hit: `POST /api/events/{id}/feedback` and
    `POST /api/feedback`.

## 0.6.2 — 2026-05-07

### Fixed

- `npx @pionne/react-native setup`: password input was leaking keystrokes
  on Node 22+ (the `_writeToOutput` override was bypassed by TTY echo,
  showing characters interleaved with bullets — `@•A•n•d•a•m•...`).
  Switched to a standalone raw-mode reader (`setRawMode(true)` + manual
  `data` listener) that pauses the parent readline interface and takes
  direct control of stdin. Verified on Node 18, 20, 22, 24.

### Added

- Progress feedback during the EAS variable provisioning. The wizard now
  prints `[i/3] <env>` while pre-checking each environment, and
  `[i/9] PIONNE_X · <env>` after each successful `eas env:create`. This
  removes the 15-20 s silent gap that previously made the wizard look
  frozen — users were quitting because they thought it had crashed.

## 0.6.1 — 2026-05-06

### Added

- `npx @pionne/react-native setup`: pre-check of existing EAS environment
  variables across `production`, `preview` and `development` before any
  modification. If `PIONNE_AUTH_TOKEN`, `PIONNE_PROJECT_ID` or `PIONNE_API`
  are already set, the wizard prints exactly which env-var pair will be
  overwritten and asks `Overwrite? (y/N)`. On a fresh install, no prompt is
  shown — installation proceeds silently.

## 0.6.0 — 2026-05-06

### Added

- `npx @pionne/react-native setup`: bilingual prompts. The wizard now asks
  for a language at startup (`Language [en/fr] (en):`) and routes every
  user-facing message through an `_(en, fr)` helper. Default stays English
  for npm-ecosystem consistency.
- Smart project auto-pick: when `app.json:expo.name` matches exactly one
  Pionne project (case-insensitive), the wizard skips the "Project number"
  prompt and uses that project. Falls back to the manual picker if 0 or
  multiple matches.

### Removed

- `Confirm (y/N)?` step at the end of the config preview. The same data is
  printed for visual review just above, and the whole `setup` is reversible
  (re-run overwrites). Use Ctrl-C before validation to abort.

## 0.5.8 — 2026-05-06

### Changed

- `npx @pionne/react-native setup`: all wizard messages translated from
  French to English to match the rest of the SDK output and the npm
  ecosystem default. Functional behavior unchanged.

### Added

- After "Setup done.", the wizard now runs `eas env:list --environment
  production` automatically so the user sees the variables actually live
  on EAS without having to type the command. Read-only, values stay
  masked thanks to `--visibility secret`.

## 0.5.7 — 2026-05-06

### Changed

- `npx @pionne/react-native setup`: migrated from the deprecated
  `eas secret:*` commands to the new `eas env:*` API. Variables are now
  pushed to all three EAS environments (development / preview / production)
  with `--visibility secret` so the build hook works on any profile.
- Each variable is deleted (best-effort) and recreated, so re-running
  `setup` cleanly overrides previous values without `already exists` errors.

## 0.5.6 — 2026-05-06

### Improved

- `npx @pionne/react-native setup`: every fetch now has a 15s timeout, so the
  wizard fails fast with "Network error: Timeout" instead of hanging silently.
- 2FA prompt now uses `rl.question()` directly (instead of write + question
  with empty prompt) so the label is reliably displayed after the password.
- A "Mot de passe OK — 2FA requise" line is printed before the 2FA prompt to
  reassure the user the password was accepted.

## 0.5.5 — 2026-05-06

### Fixed

- `npx @pionne/react-native setup`: the `_writeToOutput` masking pattern from
  0.5.3-0.5.4 broke on Node 22+ where TTY echo bypasses the override entirely
  (password rendered in cleartext, Enter then froze the wizard). Replaced
  with the npm-CLI battle-tested combination: `rl.pause()` + `setRawMode(true)`
  + manual keystroke handler that writes one `•` per char, supports Backspace
  and Ctrl-C, and resumes readline at the end. Works across Node 18–24.

## 0.5.4 — 2026-05-06

### Fixed

- `npx @pionne/react-native setup` was eating the "Mot de passe Pionne:"
  prompt itself in 0.5.3 because `rl.question('')` re-draws the current line
  through the masking `_writeToOutput` override. Now the label is passed as
  the prompt argument and the override lets the first write through.

## 0.5.3 — 2026-05-06

### Fixed

- `npx @pionne/react-native setup`: 0.5.2 still showed each keystroke
  alongside the bullet because the readline interface was echoing in
  parallel. Replaced the raw-mode hack with the `_writeToOutput` override
  pattern used by inquirer/prompts — keystrokes are now fully masked, not
  interleaved with bullets.

## 0.5.2 — 2026-05-06

### Fixed

- `npx @pionne/react-native setup` now properly hides the password while you
  type it. Switches the terminal into raw mode and renders one `•` per
  keystroke; backspace works; Ctrl-C aborts cleanly. Previously the password
  was echoed in plain text by the terminal even though the `readHidden`
  function tried to capture it.

## 0.5.1 — 2026-05-06

### Fixed

- `npx @pionne/react-native setup` now handles 2FA-protected accounts: when
  the server returns `requires_totp`, the CLI prompts for the 6-digit code
  (or a recovery code with `-`) and completes the login second step. Before
  this fix, the wizard failed instantly on accounts with TOTP enabled.

## 0.5.0 — 2026-05-06

### Added (server-side, SDK API unchanged)

- **2FA TOTP** for dashboard account — protect your bug feed with a 6-digit
  code from any authenticator app.
- **Audit log** of every sensitive action (login, password/email change,
  token regenerate, project delete) with 1-year retention and a dedicated
  Activity page in the mobile app.
- **Anomaly detection** — projects whose hourly volume crosses 10× their
  7-day baseline trigger an email alert; 50× also auto-pauses for 1h to
  neutralise leaked tokens.
- **Server-side PII scrub** (defense-in-depth) — emails, JWTs and card
  numbers are re-redacted on ingest even if `scrubPii: false` was set on
  the client by mistake.
- **Token grace period** — when regenerating a token you can keep the old
  one valid for 24h, enabling zero-downtime rotation.

### Fixed (server)

- Race condition on `bundle_id` auto-pinning closed via atomic
  `WHERE bundle_id IS NULL` UPDATE — previous code allowed concurrent
  events to overwrite each other on the very first event of a project.

## 0.4.2 — 2026-05-05

- Repository URL pointing to `agkgcreations/pionne-sdk-react-native`.

## 0.4.1 — 2026-05-05

- Internal cleanup.

## 0.4.0 — 2026-05-05

### Added

- **`<PionneErrorBoundary>`** — Error Boundary React qui capte les erreurs render que `ErrorUtils` ne voit pas. Props `fallback` (ReactNode ou function), `tags`, `onError`.
- **Auto-breadcrumbs** — `console.log/info/warn/error` et `fetch` sont automatiquement instrumentés. Les 25 derniers breadcrumbs sont attachés à chaque event. Désactivable via `breadcrumbs: false` ou `{ console: false, fetch: false }`.
- **`Pionne.wrap(fn, tags?)`** — wrapper try/catch sync+async qui capte automatiquement et rejoue l'erreur.
- **`Pionne.addBreadcrumb({ category, message, ... })`** — push manuel.
- **PII scrubber** par défaut — email, CB, IBAN, JWT, IP, tokens, téléphone scrubbed avant envoi. Désactivable via `scrubPii: false`, ou tableau de patterns custom.
- **Sample rate** — option `sampleRate: 0..1` (default `1`) pour drop aléatoire avant envoi.
- **Capture d'écran** — `captureScreenshot: true` + `Pionne.setRootRef(ref)`. Quality JPEG configurable via `screenshotQuality` (default 0.5). Nécessite `react-native-view-shot` (peer optionnelle).
- **Wrapping setTimeout/setInterval/requestAnimationFrame** — capte les exceptions sync que `ErrorUtils` rate (Hermes en dev, HMR).
- **CLI bundlé** — `npx @pionne/react-native setup` (wizard interactif, configure les EAS Secrets et écrit `eas-build-on-success.sh`). `npx @pionne/react-native upload-sourcemaps` pour upload manuel ou via hook EAS.
- **Auto bundle ID** — le SDK envoie `app_id` automatiquement via `expo-application.applicationId`. Le serveur Pionne pin la valeur au premier event (anti-token-theft).

### Changed

- `MechanismType` étendu avec `'react_error_boundary'`.
- Postinstall message au lieu de silencieux — affiche les next steps après `npm install`.

## 0.3.0 — 2026-05-05

- Auto-context Sentry-style (device, OS, app, OTA, runtime, expo_constants, sdk).
- Hermes rejection tracker.
- `app_id` envoyé automatiquement.

## 0.2.0 — 2026-05-05

- Init publique.
