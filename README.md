# @pionne/react-native

Mini Sentry mobile-first SDK pour React Native + Expo.

3 lignes pour capturer toutes les erreurs JS, voir les stacks lisibles en prod, et tout ça pour **9,99 €/mois** au lieu de 79 €.

- 🪶 **~22 KB** une fois bundlé, zéro dépendance
- 🛜 Marche avec **Expo, bare RN, Hermes & JSC**
- 🎯 Auto-capture: exceptions JS, unhandled rejections, throws dans setTimeout
- 🔌 Manuel: `captureException` / `captureMessage` / `wrap` / `<PionneErrorBoundary>`
- 🍞 **Breadcrumbs auto** (console + fetch) attachés à chaque event
- 📸 **Capture d'écran** opt-in attachée à chaque erreur
- 🗺️ **Source maps** résolus côté serveur (stack lisible en prod)
- 🔒 **Bundle ID auto-pinning** anti-token-theft
- 🛡️ **PII scrubber** par défaut (email, CB, IBAN, JWT, IP, tokens)
- 🎚️ **Sample rate** anti-flood
- 🪝 `beforeSend` pour scrubbing custom

## Install

```bash
npm install @pionne/react-native
```

Optionnel (peer deps):
```bash
npx expo install expo-application expo-device expo-updates expo-constants
npx expo install react-native-view-shot          # pour les screenshots
npx expo install @react-native-async-storage/async-storage  # pour la queue offline
```

## Récupère ton token

Pionne est mobile-first : tu génères et tu visualises tes erreurs **depuis l'app mobile Pionne**, pas depuis un panneau web qui scrolle mal sur téléphone.

1. **Télécharge l'app Pionne** :
   - 🍎 [App Store](https://apps.apple.com/app/pionne) *(à venir)*
   - 🤖 [Google Play](https://play.google.com/store/apps/details?id=fr.agkgcreations.pionne) *(à venir)*
2. Crée ton compte (30 jours gratuits, carte non requise)
3. **+ Nouveau projet** → choisis ta plateforme → copie le token affiché en grand (commence par `pio_live_…`)
4. Colle-le dans ton app via `Pionne.init({ token })` (cf ci-dessous)

⚠️ Le token n'est affiché **qu'une seule fois** à la création — stocke-le dans une variable d'environnement (`EXPO_PUBLIC_PIONNE_TOKEN`) ou directement dans `app.json` → `extra.pionneToken`.

## Skip the SDK in dev

Pour ne pas polluer ton dashboard prod avec les events que tu génères en Metro / Expo Go (et éviter le casse-tête du bundle ID mismatch), passe `enableInDev: false` :

```ts
Pionne.init({
  token: 'pio_live_…',
  enableInDev: false, // no-op in __DEV__
});
```

En `__DEV__`, l'init log `[Pionne] Skipped in __DEV__ (enableInDev=false)` et toutes les méthodes (`captureException`, `captureMessage`, `setUser`, etc.) deviennent silencieuses pour la durée du process. Aucun handler global n'est installé, aucune session n'est ouverte. Comportement par défaut : `enableInDev: true` (rétrocompat).

## Quickstart

```ts
import { Pionne } from '@pionne/react-native';

Pionne.init({
  token: 'pio_live_xxx',     // depuis l'app mobile Pionne
  release: '1.0.0',
  environment: 'production',
});
```

C'est tout. Toutes les exceptions JS et unhandled promises remontent au dashboard de l'app Pionne, dédoublonnées par fingerprint, avec stack trace, OS, modèle d'appareil et version d'app.

## Setup auto-upload sourcemaps

Une commande, configure les EAS Secrets et écrit le hook EAS Build :

```bash
npx @pionne/react-native setup
```

À chaque `eas build`, les `.map` sont uploadés tout seuls. En prod tes stack traces s'affichent en `App.tsx:42 (CheckoutScreen)` au lieu de `bundle:3:18745`.

> **Note (≥ 0.8.2)** : les sourcemaps sont gzippées avant upload (~10× plus petites). Compatible avec les hébergeurs qui ont un `LimitRequestBody` Apache bas (O2switch, etc.). Le serveur Pionne détecte automatiquement le format compressé.

## API

```ts
// Init avec toutes les options
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

// Wrap async/sync — capte + rejoue automatiquement
const submit = Pionne.wrap(async () => {
  await api.post('/order');
});

// Breadcrumbs manuels (en plus de l'auto-instrumentation)
Pionne.addBreadcrumb({ category: 'ui', message: 'tap "checkout"' });

// Identifier un user
Pionne.setUser('anon_a1b2c3');     // any opaque id
Pionne.setUser(null);               // logout

// Tags
Pionne.setTags({ plan: 'pro' });

// Désactiver à chaud
Pionne.setEnabled(false);
```

## React Error Boundary

Capte les erreurs render React (que `ErrorUtils` ne voit pas):

```tsx
import { PionneErrorBoundary } from '@pionne/react-native';

<PionneErrorBoundary
  fallback={({ error, reset }) => (
    <View>
      <Text>Quelque chose a planté: {error.message}</Text>
      <Button onPress={reset} title="Réessayer" />
    </View>
  )}
>
  <App />
</PionneErrorBoundary>
```

## Capture d'écran

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

À chaque erreur, un JPG (qualité 0.5) de la vue racine est attaché. Visible dans le tab "Capture" du détail issue.

## CLI

```bash
# Wizard interactif: configure EAS Secrets + écrit le hook
npx @pionne/react-native setup

# Upload sourcemaps en CI/EAS
npx @pionne/react-native upload-sourcemaps --platform ios

# Help
npx @pionne/react-native --help
```

## Profiling (Hermes only)

Profile manuellement les écrans/transactions critiques pour visualiser un **flame graph** dans le dashboard mobile et détecter les régressions de perf entre releases.

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

Le SDK utilise le sampler natif Hermes (`HermesInternal.dumpSampledTrace`) — overhead ~1–3 % CPU pendant la capture, **zéro overhead quand inactif**. JSC ne supporte pas le sampling : la fonction renvoie `false` silencieusement (un `console.info` en dev pour t'avertir).

Les samples sont envoyés à `POST /api/profiles` (rate-limit partagé avec `/ingest`). Format : Chrome Trace Event Format brut, agrégé en P50/P95/P99 par fonction côté serveur pour le flame graph + le diff cross-release.

API complète :

| Méthode | Rôle |
|---|---|
| `Pionne.startProfile(name, meta?)` | Démarre une capture. Idempotent si même `name`. |
| `Pionne.stopProfile()` → `Promise<id \| null>` | Stop + upload, renvoie l'ID serveur. |
| `Pionne.profile(name, fn, meta?)` | Sucre — wrap une fn ou Promise. |

`meta` accepte `{ route?: string, eventId?: number }` — `eventId` lie le profile à un crash event spécifique pour le drill-down.

## Options

| Option | Default | Description |
|---|---|---|
| `token` | required | `pio_live_…` (depuis l'app Pionne) |
| `endpoint` | `https://pionne.agkgcreations.fr/api/ingest` | API URL |
| `release` | auto (`expo.version`) | App release pour grouper les régressions |
| `environment` | `__DEV__ ? 'development' : 'production'` | label environnement |
| `enabled` | `true` | Toggle reporting |
| `enableInDev` | `true` | Set to `false` to make `init()` no-op in `__DEV__`. Recommandé pour ne pas polluer le dashboard prod avec des events Expo Go / Metro. |
| `captureUncaughtErrors` | `true` | ErrorUtils + timer wrapping |
| `captureUnhandledRejections` | `true` | Hermes rejection tracker |
| `breadcrumbs` | `true` | Auto-instrument console + fetch |
| `scrubPii` | `true` | Scrub email/CB/IBAN/JWT/IP/tokens |
| `sampleRate` | `1` | Drop ratio (0..1) |
| `captureScreenshot` | `false` | JPG de la vue racine à chaque erreur |
| `screenshotQuality` | `0.5` | Qualité JPEG (0..1) |
| `tags` | — | Tags ajoutés à chaque event |
| `userIdAnon` | — | ID anon (pas un email) |
| `appId` | auto | Bundle ID (anti-token-theft) |
| `beforeSend` | — | Hook avant envoi (return null = drop) |
| `maxStackFrames` | `50` | Frames sent par event |
| `maxEventsPerSecond` | `10` | Token-bucket client. Au-delà, drop silencieux. `0` pour désactiver (déconseillé). Le serveur a aussi son propre rate-limit par token, indépendant. |
| `releaseHealth` | `true` | Open une session à `init()` pour calculer le crash-free user rate. |
| `sendGeography` | `false` | Opt-in : attache `contexts.geo` (city/region/country) résolu IP-side. |

## Pricing

**9,99 €/mois** ou 89,99 €/an. 30 jours d'essai (carte non requise). 50 000 events/mois, projets illimités, rétention 30j.

[Docs complètes](https://pionne.agkgcreations.fr/quickstart)

## Changelog

- **0.8.6** — Permanent rejection (401/403/422) : message d'erreur enrichi côté SDK. Le `console.warn` (loggé une fois même en prod, type TestFlight) parse le JSON de réponse, distingue les cas (Bundle ID mismatch / token rejected / 422 validation), affiche l'`app_id` envoyé + l'`expected_format` masqué retourné par le serveur, et donne une instruction actionnable (où corriger). Pas de breaking change.
- **0.8.5** — `enableInDev` option pour rendre `init()` no-op en `__DEV__`.
- **0.8.2** — CLI : sourcemaps gzippées automatiquement avant upload (~10× plus petites). Passe les `LimitRequestBody` Apache bas des hébergeurs mutualisés (O2switch, etc.). Le serveur Pionne décode de manière transparente.
- **0.8.0** — Profiling Hermes : `Pionne.startProfile / stopProfile / profile`.
- **0.7.x** — CLI bilingue (en/fr), auto-pick projet via `app.json:expo.name`, pre-check des EAS env vars.
- **0.5.0** — Release Health (sessions crash-free user rate), feedback widget, geo IP-side.

## License

MIT © AGKG Creations
