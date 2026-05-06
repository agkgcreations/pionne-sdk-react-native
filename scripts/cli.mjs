#!/usr/bin/env node
//
// CLI Pionne pour les devs qui utilisent @pionne/react-native.
// Cross-platform (Node, pas Bash) — marche sur macOS, Linux, Windows.
//
// Usage:
//   npx @pionne/react-native setup              # wizard interactif
//   npx @pionne/react-native upload-sourcemaps  # CI / EAS hook
//   npx @pionne/react-native --help
//

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execSync, spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const VIOLET = '\x1b[38;5;105m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';

const log = (s) => console.log(s);
const ok = (s) => log(`${GREEN}✓${RESET} ${s}`);
const warn = (s) => log(`${YELLOW}⚠${RESET} ${s}`);
const die = (s) => { log(`${RED}✗${RESET} ${s}`); process.exit(1); };

const cmd = process.argv[2] ?? 'help';

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

(async () => {
  switch (cmd) {
    case 'setup': await setup(); break;
    case 'upload-sourcemaps': await uploadSourcemaps(); break;
    case 'help':
    case '--help':
    case '-h': printHelp(); break;
    default:
      log(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
})().catch((e) => {
  die(e.message ?? String(e));
});

// ─────────────────────────────────────────────────────────────────────────
// HELP
// ─────────────────────────────────────────────────────────────────────────

function printHelp() {
  log(`
${BOLD}${VIOLET}@pionne/react-native — CLI${RESET}

Usage:
  ${BOLD}npx @pionne/react-native setup${RESET}
      Wizard interactif. Login Pionne → choix du projet → configure les
      EAS Secrets et écrit eas-build-on-success.sh dans ton repo. Une fois
      fait, chaque \`eas build\` upload ses sourcemaps tout seul.

  ${BOLD}npx @pionne/react-native upload-sourcemaps${RESET} [--platform ios|android]
      Upload des sourcemaps en mode non-interactif. Lit PIONNE_AUTH_TOKEN,
      PIONNE_PROJECT_ID, PIONNE_API depuis l'environnement (EAS Secrets en
      CI, ou flags). Utilisé par eas-build-on-success.sh.

Variables d'environnement:
  PIONNE_AUTH_TOKEN     Token Sanctum (eas secret:create)
  PIONNE_PROJECT_ID     ID du projet Pionne
  PIONNE_API            Endpoint API (default: https://pionne.agkgcreations.fr/api)
  EAS_BUILD_PLATFORM    Auto-fourni par EAS Build (ios|android)

Docs: https://pionne.agkgcreations.fr/docs
`);
}

// ─────────────────────────────────────────────────────────────────────────
// SETUP WIZARD
// ─────────────────────────────────────────────────────────────────────────

async function setup() {
  log(`\n${VIOLET}${BOLD}=== Pionne — Setup ===${RESET}\n`);

  const cwd = process.env.INIT_CWD || process.cwd();
  if (!existsSync(join(cwd, 'app.json')) && !existsSync(join(cwd, 'package.json'))) {
    die(`Lance cette commande depuis la racine de ton projet Expo (où se trouve app.json).`);
  }

  // 1. Vérifie eas-cli
  if (!hasCommand('eas')) {
    warn(`eas-cli non installé. Run: npm install -g eas-cli`);
    return;
  }

  let easUser;
  try {
    easUser = execSync('eas whoami', { stdio: 'pipe' }).toString().trim();
    ok(`Loggé EAS: ${easUser}`);
  } catch {
    warn(`Tu n'es pas loggé EAS. Run: eas login`);
    return;
  }

  // 2. Login Pionne
  const api = process.env.PIONNE_API || 'https://pionne.agkgcreations.fr/api';
  const rl = createInterface({ input, output });

  const email = await rl.question(`Email Pionne: `);
  // Hide stdin during password input.
  const password = await readHidden(rl, `Mot de passe Pionne: `);

  log(`${YELLOW}→ Login sur ${api}...${RESET}`);
  let loginRes = await postJson(`${api}/auth/login`, { email, password });

  // Two-factor auth — server asks for a TOTP code as a second step.
  if (loginRes?.requires_totp && loginRes.totp_token) {
    output.write(`Code 2FA (6 chiffres) ou code de récupération: `);
    const totpInput = (await rl.question('')).trim();
    const isRecovery = totpInput.includes('-') || totpInput.length > 6;
    loginRes = await postJson(`${api}/auth/login/totp`, {
      totp_token: loginRes.totp_token,
      code: isRecovery ? undefined : totpInput,
      recovery_code: isRecovery ? totpInput : undefined,
    });
  }

  if (!loginRes?.token) {
    die(`Login échoué: ${JSON.stringify(loginRes)}`);
  }
  const authToken = loginRes.token;
  ok(`Login OK`);

  // 3. List projects
  log(`${YELLOW}→ Récupération des projets...${RESET}`);
  const { projects = [] } = await getJson(`${api}/projects`, authToken);
  if (!projects.length) {
    die(`Aucun projet. Crée-en un dans l'app Pionne d'abord.`);
  }

  let projectId;
  if (projects.length === 1) {
    projectId = projects[0].id;
    ok(`Un seul projet, sélection auto: [id=${projectId}] ${projects[0].name}`);
  } else {
    log('');
    projects.forEach((p, i) => {
      log(`  ${i + 1}) [id=${p.id}] ${p.name} (${p.platform})`);
    });
    log('');
    const idx = await rl.question(`Numéro du projet: `);
    projectId = projects[parseInt(idx, 10) - 1]?.id;
    if (!projectId) die(`Numéro invalide.`);
  }

  // 4. Confirm + create EAS Secrets
  log(``);
  log(`${BOLD}Configuration EAS Secrets:${RESET}`);
  log(`  PIONNE_AUTH_TOKEN  = ${authToken.slice(0, 20)}...`);
  log(`  PIONNE_PROJECT_ID  = ${projectId}`);
  log(`  PIONNE_API         = ${api}`);
  log(``);

  const confirm = await rl.question(`Confirmer (y/N)? `);
  rl.close();
  if (confirm.toLowerCase() !== 'y') {
    log(`Annulé.`);
    return;
  }

  for (const name of ['PIONNE_AUTH_TOKEN', 'PIONNE_PROJECT_ID', 'PIONNE_API']) {
    spawnSync('eas', ['secret:delete', '--scope', 'project', '--name', name, '--non-interactive'], {
      stdio: 'ignore',
    });
  }
  for (const [name, value] of [
    ['PIONNE_AUTH_TOKEN', authToken],
    ['PIONNE_PROJECT_ID', String(projectId)],
    ['PIONNE_API', api],
  ]) {
    const r = spawnSync(
      'eas',
      ['secret:create', '--scope', 'project', '--name', name, '--value', value, '--type', 'string', '--non-interactive'],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) die(`eas secret:create ${name} a échoué`);
  }

  // 5. Install eas-build-on-success.sh
  const hookPath = join(cwd, 'eas-build-on-success.sh');
  const hookContents = readPackageFile('templates/eas-build-on-success.sh');
  if (existsSync(hookPath)) {
    warn(`eas-build-on-success.sh existe déjà — pas écrasé.`);
  } else {
    writeFileSync(hookPath, hookContents, { mode: 0o755 });
    ok(`Hook EAS écrit: eas-build-on-success.sh`);
  }

  log(`\n${GREEN}${BOLD}✓ Setup terminé.${RESET}`);
  log(`Désormais, chaque ${BOLD}eas build${RESET} uploadera ses sourcemaps tout seul.`);
}

// ─────────────────────────────────────────────────────────────────────────
// UPLOAD SOURCEMAPS (utilisé par le hook EAS)
// ─────────────────────────────────────────────────────────────────────────

async function uploadSourcemaps() {
  const args = parseArgs(process.argv.slice(3));
  const api = args.api ?? process.env.PIONNE_API ?? 'https://pionne.agkgcreations.fr/api';
  const token = args.token ?? process.env.PIONNE_AUTH_TOKEN;
  const projectId = args.project ?? process.env.PIONNE_PROJECT_ID;
  const platform = args.platform ?? process.env.EAS_BUILD_PLATFORM;
  let release = args.release;
  let mapPath = args.map;

  if (!token || !projectId) {
    log(`[Pionne] PIONNE_AUTH_TOKEN/PIONNE_PROJECT_ID absents — skip sourcemap upload.`);
    return;
  }
  if (!platform) die(`--platform required (or EAS_BUILD_PLATFORM env)`);

  if (!release) {
    const cwd = process.env.INIT_CWD || process.cwd();
    const appJsonPath = join(cwd, 'app.json');
    if (existsSync(appJsonPath)) {
      try {
        release = JSON.parse(readFileSync(appJsonPath, 'utf8')).expo?.version;
      } catch {}
    }
  }
  if (!release) die(`--release required (or expo.version in app.json)`);

  if (!mapPath) {
    const candidates = platform === 'ios'
      ? [
          'ios/build/Build/Products/Release-iphoneos/main.jsbundle.map',
          ...glob('dist/_expo/static/js/ios/*.map'),
        ]
      : [
          'android/app/build/intermediates/sourcemaps/release/index.android.bundle.map',
          'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map',
          ...glob('dist/_expo/static/js/android/*.map'),
        ];
    mapPath = candidates.find((c) => existsSync(c));
    if (!mapPath) die(`No .map found in: ${candidates.join(', ')}`);
  }

  const bytes = statSync(mapPath).size;
  log(`→ Upload ${mapPath}`);
  log(`  release=${release} platform=${platform} project=${projectId} bytes=${bytes}`);

  // Upload multipart via fetch (Node 18+).
  const formData = new FormData();
  formData.append('release', release);
  formData.append('platform', platform);
  const fileBuffer = readFileSync(mapPath);
  formData.append(
    'file',
    new Blob([fileBuffer]),
    mapPath.split('/').pop(),
  );

  const res = await fetch(`${api}/projects/${projectId}/sourcemaps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body: formData,
  });

  if (res.ok) {
    ok(`Upload OK (HTTP ${res.status})`);
  } else {
    warn(`Upload failed (HTTP ${res.status}): ${await res.text()}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function hasCommand(name) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return r.status === 0;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function getJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.json().catch(() => ({}));
}

async function readHidden(rl, prompt = '') {
  return new Promise((resolve) => {
    // Override readline's internal echo so each user keystroke renders as a
    // bullet. The very first _writeToOutput call is the prompt itself —
    // we let it through. Everything after is user input → mask. Newlines
    // also pass through so <Enter> draws a line break.
    let promptDrawn = false;
    const original = rl._writeToOutput;
    rl._writeToOutput = function (s) {
      if (!promptDrawn) {
        promptDrawn = true;
        rl.output.write(s);
        return;
      }
      if (/[\n\r]/.test(s)) {
        rl.output.write(s);
      } else {
        rl.output.write('\u2022'.repeat(s.length));
      }
    };
    rl.question(prompt, (line) => {
      rl._writeToOutput = original;
      resolve(line);
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function glob(pattern) {
  // Minimal glob: just expand `dir/*.ext` patterns.
  const m = pattern.match(/^(.*?)\/\*(\..+)?$/);
  if (!m) return [pattern];
  const dir = m[1];
  const ext = m[2] ?? '';
  if (!existsSync(dir)) return [];
  try {
    const { readdirSync } = require('node:fs');
    return readdirSync(dir)
      .filter((f) => !ext || f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function readPackageFile(rel) {
  // Le package est installé à node_modules/@pionne/react-native/, on lit
  // depuis le dossier `templates` du package.
  const here = new URL('.', import.meta.url).pathname;
  return readFileSync(resolve(here, '..', rel), 'utf8');
}
