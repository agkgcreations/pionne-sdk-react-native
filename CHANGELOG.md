# Changelog

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
