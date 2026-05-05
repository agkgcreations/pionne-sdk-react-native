# Changelog

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
