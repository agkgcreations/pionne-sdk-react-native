#!/usr/bin/env bash
#
# Hook EAS Build généré par `npx @pionne/react-native setup`.
# Tourne automatiquement après chaque build EAS réussi pour upload les
# sourcemaps Metro/Hermes vers Pionne.
#
# Configure les EAS Secrets une fois pour toutes :
#   PIONNE_AUTH_TOKEN, PIONNE_PROJECT_ID, PIONNE_API
#
# Si les secrets sont absents, ce hook skip silencieusement (le build n'échoue jamais).

set -e

if [[ -z "${PIONNE_AUTH_TOKEN:-}" ]] || [[ -z "${PIONNE_PROJECT_ID:-}" ]]; then
  echo "[Pionne] secrets absents — skip sourcemap upload"
  exit 0
fi

# Le CLI est dans @pionne/react-native (déjà installé via npm).
npx --yes @pionne/react-native upload-sourcemaps \
  || echo "[Pionne] upload failed — non-fatal, build continues."
