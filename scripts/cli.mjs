#!/usr/bin/env node
//
// Pionne CLI for @pionne/react-native users.
// Cross-platform (Node, not Bash) — runs on macOS, Linux, Windows.
//
// Usage:
//   npx @pionne/react-native setup              # interactive wizard
//   npx @pionne/react-native upload-sourcemaps  # CI / EAS hook
//   npx @pionne/react-native --help
//

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execSync, spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { gzipSync } from 'node:zlib';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const VIOLET = '\x1b[38;5;105m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';


// ─── i18n helpers ────────────────────────────────────────────────────────
// Bilingual strings — chosen at wizard start. Keeping it inline avoids
// pulling in an i18n library for a 50-string CLI.
let _lang = 'en';
const _ = (en, fr) => (_lang === 'fr' ? fr : en);

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
      Interactive wizard. Pionne login → project picker → configures EAS
      environment variables and writes eas-build-on-success.sh in your repo.
      Each subsequent \`eas build\` then uploads its sourcemaps automatically.

  ${BOLD}npx @pionne/react-native upload-sourcemaps${RESET} [--platform ios|android]
      Non-interactive sourcemap upload. Reads PIONNE_AUTH_TOKEN,
      PIONNE_PROJECT_ID, PIONNE_API from the environment (EAS env vars in CI,
      or flags). Used by eas-build-on-success.sh.

Environment variables:
  PIONNE_AUTH_TOKEN     Sanctum token (eas env:create --visibility secret)
  PIONNE_PROJECT_ID     Pionne project ID
  PIONNE_API            API endpoint (default: https://pionne.agkgcreations.fr/api)
  EAS_BUILD_PLATFORM    Auto-provided by EAS Build (ios|android)

Docs: https://pionne.agkgcreations.fr/docs
`);
}

// ─────────────────────────────────────────────────────────────────────────
// SETUP WIZARD
// ─────────────────────────────────────────────────────────────────────────

async function setup() {
  log(`\n${VIOLET}${BOLD}=== Pionne — Setup ===${RESET}\n`);

  // 0. Language pick — default English (npm ecosystem default).
  {
    const ttyRl = createInterface({ input, output });
    const ans = (await ttyRl.question(`Language [en/fr] (en): `)).trim().toLowerCase();
    ttyRl.close();
    if (ans === 'fr' || ans === 'french' || ans === 'français') _lang = 'fr';
  }


  const cwd = process.env.INIT_CWD || process.cwd();
  if (!existsSync(join(cwd, 'app.json')) && !existsSync(join(cwd, 'package.json'))) {
    die(_(`Run this command from the root of your Expo project (where app.json lives).`, `Lance cette commande depuis la racine de ton projet Expo (où se trouve app.json).`));
  }

  // 1. Vérifie eas-cli
  if (!hasCommand('eas')) {
    warn(_(`eas-cli not installed. Run: npm install -g eas-cli`, `eas-cli n'est pas installé. Lance: npm install -g eas-cli`));
    return;
  }

  let easUser;
  try {
    easUser = execSync('eas whoami', { stdio: 'pipe' }).toString().trim();
    ok(_(`Logged into EAS: ${easUser}`, `Connecté à EAS : ${easUser}`));
  } catch {
    warn(_(`Not logged into EAS. Run: eas login`, `Pas connecté à EAS. Lance: eas login`));
    return;
  }

  // 2. Login Pionne
  const api = process.env.PIONNE_API || 'https://pionne.agkgcreations.fr/api';
  let rl = createInterface({ input, output });

  const email = await rl.question(_(`Pionne email: `, `Email Pionne : `));
  // Fully close rl before the password prompt — sharing stdin between
  // a paused readline and our raw-mode handler leaks the typed char on
  // Node 22+/zsh. We re-open a fresh rl right after.
  rl.close();
  const password = await readHidden(_(`Pionne password: `, `Mot de passe Pionne : `));
  rl = createInterface({ input, output });

  log(`${YELLOW}→ ${_(`Logging in to`, `Connexion à`)} ${api}...${RESET}`);
  let loginRes;
  try {
    loginRes = await postJson(`${api}/auth/login`, { email, password });
  } catch (e) {
    die(`Network error: ${e.message}`);
  }

  // Two-factor auth — server asks for a TOTP code as a second step.
  if (loginRes?.requires_totp && loginRes.totp_token) {
    log(`${GREEN}✓${RESET} ${_(`Password OK — 2FA required.`, `Mot de passe OK — 2FA requise.`)}`);
    const totpInput = (await rl.question(_(`2FA code (6 digits) or recovery code: `, `Code 2FA (6 chiffres) ou code de récupération : `))).trim();
    if (!totpInput) die(_('No 2FA code provided.', 'Aucun code 2FA fourni.'));
    const isRecovery = totpInput.includes('-') || totpInput.length > 6;
    try {
      loginRes = await postJson(`${api}/auth/login/totp`, {
        totp_token: loginRes.totp_token,
        code: isRecovery ? undefined : totpInput,
        recovery_code: isRecovery ? totpInput : undefined,
      });
    } catch (e) {
      die(`Network error during 2FA: ${e.message}`);
    }
  }

  if (!loginRes?.token) {
    die(`${_(`Login failed`, `Connexion refusée`)}: ${JSON.stringify(loginRes)}`);
  }
  const authToken = loginRes.token;
  ok(_(`Login OK`, `Connexion OK`));

  // 3. List projects
  log(`${YELLOW}→ ${_(`Fetching projects...`, `Récupération des projets...`)}${RESET}`);
  const { projects = [] } = await getJson(`${api}/projects`, authToken);
  if (!projects.length) {
    die(_(`No projects yet. Create one in the Pionne mobile app first.`, `Aucun projet. Crée-en un dans l'app Pionne d'abord.`));
  }

  let projectId;
  // Try to auto-pick by matching `app.json:expo.name` against project names
  // (case-insensitive, exact match). Saves the user from typing a number.
  let appJsonName;
  try {
    const aj = JSON.parse(readFileSync(join(cwd, 'app.json'), 'utf8'));
    appJsonName = (aj?.expo?.name ?? '').toLowerCase();
  } catch {}
  const exactMatches = appJsonName
    ? projects.filter((p) => p.name.toLowerCase() === appJsonName)
    : [];

  if (projects.length === 1) {
    projectId = projects[0].id;
    ok(_(
      `Single project, auto-selected: [id=${projectId}] ${projects[0].name}`,
      `Un seul projet, sélection auto : [id=${projectId}] ${projects[0].name}`,
    ));
  } else if (exactMatches.length === 1) {
    projectId = exactMatches[0].id;
    ok(_(
      `Auto-picked from app.json:expo.name: [id=${projectId}] ${exactMatches[0].name}`,
      `Sélection auto via app.json:expo.name : [id=${projectId}] ${exactMatches[0].name}`,
    ));
  } else {
    log('');
    projects.forEach((p, i) => {
      log(`  ${i + 1}) [id=${p.id}] ${p.name} (${p.platform})`);
    });
    log('');
    const idx = await rl.question(_(`Project number: `, `Numéro du projet : `));
    projectId = projects[parseInt(idx, 10) - 1]?.id;
    if (!projectId) die(_(`Invalid number.`, `Numéro invalide.`));
  }

  // 4. Confirm + create EAS Secrets
  log(``);
  log(`${BOLD}${_(`EAS environment variables to set:`, `Variables EAS à configurer :`)}${RESET}`);
  log(`  PIONNE_AUTH_TOKEN  = ${authToken.slice(0, 20)}...`);
  log(`  PIONNE_PROJECT_ID  = ${projectId}`);
  log(`  PIONNE_API         = ${api}`);
  log(``);

  // Pre-check: app.json must already be linked to an EAS project (i.e. have
  // `extra.eas.projectId`). Without it `eas env:*` fails with a generic
  // "command failed" that leaves devs guessing. We catch the case here and
  // tell them the exact `eas init` command to run.
  ensureEasProjectLinked(cwd);

  // EAS migrated `eas secret:*` → `eas env:*` (env vars per environment).
  // We push to the three standard environments so the hook works whichever
  // build profile the user picks (development / preview / production).
  const envs = ['production', 'preview', 'development'];
  const entries = [
    ['PIONNE_AUTH_TOKEN', authToken],
    ['PIONNE_PROJECT_ID', String(projectId)],
    ['PIONNE_API', api],
  ];
  const varNames = entries.map(([n]) => n);

  // Pre-check: list existing PIONNE_* vars across the three envs so we can
  // warn the user explicitly before overwriting. Silent fallback if eas-cli
  // doesn't support the listing format we expect (we just proceed).
  log(`${YELLOW}→ ${_('Checking existing EAS variables...', 'Vérification des variables EAS existantes...')}${RESET}`);
  const existing = listExistingPionneVars(envs, varNames, (env, i, total) => {
    log(`  ${GREY}[${i}/${total}] ${env}${RESET}`);
  });
  if (existing.length === 0) {
    ok(_('No existing PIONNE_* variables — fresh install.', 'Aucune variable PIONNE_* existante — installation propre.'));
  } else {
    warn(_('The following PIONNE_* variables will be overwritten:', 'Les variables PIONNE_* suivantes seront écrasées :'));
    for (const { env, names } of existing) {
      log(`  • ${env}: ${names.join(', ')}`);
    }
    log('');
    const ans = (await rl.question(_('Overwrite? (y/N): ', 'Écraser ? (y/N) : '))).trim().toLowerCase();
    if (ans !== 'y') {
      rl.close();
      log(_('Cancelled. Existing variables left untouched.', 'Annulé. Variables existantes inchangées.'));
      return;
    }
  }
  rl.close();

  // Best-effort delete pass (silent — non-existent vars are fine).
  for (const env of envs) {
    for (const [name] of entries) {
      spawnSync(
        'eas',
        ['env:delete', '--variable-name', name, '--variable-environment', env, '--non-interactive'],
        { stdio: 'ignore' },
      );
    }
  }

  // Create pass — print progress for each var × env so the user sees the
  // wizard is alive (eas env:create takes ~1-2s each, total ~15-20s for
  // 9 entries × 3 envs).
  log(`${YELLOW}→ ${_('Creating EAS variables (3 × 3 = 9 entries)...', 'Création des variables EAS (3 × 3 = 9 entrées)...')}${RESET}`);
  let createIdx = 0;
  const createTotal = envs.length * entries.length;
  for (const env of envs) {
    for (const [name, value] of entries) {
      createIdx++;
      const r = spawnSync(
        'eas',
        [
          'env:create',
          '--name', name,
          '--value', value,
          '--visibility', 'secret',
          '--environment', env,
          '--non-interactive',
          '--force',
        ],
        { stdio: 'pipe', encoding: 'utf8' },
      );
      if (r.status !== 0) {
        log(`  ${RED}✗${RESET} ${name} (${env})`);
        if (r.stderr) output.write(r.stderr);
        explainEasFailureAndDie(r.stderr ?? '', r.stdout ?? '', name, env);
      }
      log(`  ${GREEN}✓${RESET} [${createIdx}/${createTotal}] ${name} ${GREY}·${RESET} ${env}`);
    }
  }

  // 5. Install eas-build-on-success.sh
  const hookPath = join(cwd, 'eas-build-on-success.sh');
  const hookContents = readPackageFile('templates/eas-build-on-success.sh');
  if (existsSync(hookPath)) {
    warn(_(`eas-build-on-success.sh already exists — not overwritten.`, `eas-build-on-success.sh existe déjà — non écrasé.`));
  } else {
    writeFileSync(hookPath, hookContents, { mode: 0o755 });
    ok(_(`EAS hook written: eas-build-on-success.sh`, `Hook EAS écrit : eas-build-on-success.sh`));
  }

  log(`\n${GREEN}${BOLD}✓ ${_(`Setup done.`, `Setup terminé.`)}${RESET}`);
  log(_(`From now on, every ${BOLD}eas build${RESET} will upload its sourcemaps automatically.`, `Désormais, chaque ${BOLD}eas build${RESET} upload ses sourcemaps tout seul.`));

  // Final verification — list the production env vars so the user sees them
  // confirmed without having to type the command themselves. Read-only, the
  // `secret` visibility ensures values stay masked.
  log(`\n${YELLOW}→ ${_(`Verifying — EAS env vars (production):`, `Vérification — variables EAS (production) :`)}${RESET}`);
  spawnSync('eas', ['env:list', '--environment', 'production'], { stdio: 'inherit' });
}

// ─────────────────────────────────────────────────────────────────────────
// UPLOAD SOURCEMAPS (used by the EAS build hook)
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
    log(`[Pionne] PIONNE_AUTH_TOKEN/PIONNE_PROJECT_ID missing — skipping sourcemap upload.`);
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

  // gzip systématique avant upload : les sourcemaps RN/Metro sont du JSON
  // très répétitif, gzip les ramène typiquement à ~10-15 % de leur taille.
  // Indispensable pour les hébergeurs avec LimitRequestBody bas
  // (ex: O2switch ~10 MB par défaut). Le serveur Pionne détecte le suffix
  // `.gz` (ou les magic bytes 1f 8b) et stocke/décode en conséquence.
  // Sans coût significatif côté CLI : gzipSync sur 20 MB prend < 200 ms.
  const formData = new FormData();
  formData.append('release', release);
  formData.append('platform', platform);
  const fileBuffer = readFileSync(mapPath);
  const gzipped = gzipSync(fileBuffer, { level: 9 });
  log(`  compressed: ${gzipped.length} bytes (${Math.round(gzipped.length / fileBuffer.length * 100)}% of original)`);
  const baseName = mapPath.split('/').pop();
  formData.append(
    'file',
    new Blob([gzipped]),
    `${baseName}.gz`,
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

/**
 * Probes `eas env:list` for each environment and reports which of the
 * provided var names already exist. Best-effort: failures are silent and
 * yield an empty list so the wizard can still proceed.
 *
 * @param {string[]} envs   - e.g. ['production', 'preview', 'development']
 * @param {string[]} names  - e.g. ['PIONNE_AUTH_TOKEN', ...]
 * @returns {Array<{env: string, names: string[]}>}
 */
/**
 * Bail out with a precise, actionable message if the host project isn't
 * linked to an EAS project yet (`extra.eas.projectId` missing in app.json).
 *
 * Without this guard, the wizard reaches `eas env:create` and dies on a
 * generic "command failed" — devs then have no idea the real cause is
 * "you never ran eas init". This helper surfaces the right next step.
 */
function ensureEasProjectLinked(cwd) {
  const path = join(cwd, 'app.json');
  if (!existsSync(path)) return; // bare RN — leave it to eas-cli to complain
  let aj;
  try {
    aj = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // unreadable JSON — skip the pre-check, eas-cli will fail anyway
  }
  const projectId = aj?.expo?.extra?.eas?.projectId;
  if (typeof projectId === 'string' && projectId.length) return;

  log('');
  log(`${RED}${BOLD}✗ ${_(
    'No EAS project linked to this app yet.',
    "Aucun projet EAS n'est lié à cette app pour le moment."
  )}${RESET}`);
  log(_(
    `Your ${BOLD}app.json${RESET} has no ${BOLD}expo.extra.eas.projectId${RESET}, so eas-cli has nothing to write env vars onto. This means you haven't created the project on Expo's side yet.`,
    `Ton ${BOLD}app.json${RESET} n'a pas de ${BOLD}expo.extra.eas.projectId${RESET}, donc eas-cli n'a aucun projet sur lequel écrire les variables. Autrement dit, le projet n'existe pas encore côté Expo.`,
  ));
  log('');
  log(`${BOLD}${_('Fix in 30 seconds:', 'À faire en 30 secondes :')}${RESET}`);
  log(`  1) ${_('Sign in (free) at', 'Inscris-toi (gratuit) sur')} ${BOLD}https://expo.dev${RESET}`);
  log(`  2) ${_('In this project run:', 'Dans ce projet, lance :')} ${BOLD}eas init${RESET}`);
  log(`     ${GREY}${_('— picks an existing EAS project or creates a new one and writes the projectId into app.json', '— sélectionne un projet EAS existant ou en crée un nouveau, et écrit le projectId dans app.json')}${RESET}`);
  log(`  3) ${_('Re-run', 'Relance')} ${BOLD}npx pionne setup${RESET}`);
  log('');
  process.exit(1);
}

/**
 * Pretty-prints the most likely cause of an `eas env:create` failure based
 * on patterns we've seen in the wild, then exits. Falls back to a generic
 * message — the raw stderr was already streamed to the user above so they
 * can still see the original eas-cli output.
 */
function explainEasFailureAndDie(stderr, stdout, name, env) {
  const blob = `${stderr}\n${stdout}`.toLowerCase();

  // No EAS project (most common) — covers several phrasings eas-cli has
  // shipped over the last year. Same wording across all of them: "the
  // project doesn't exist on Expo, run eas init".
  if (
    blob.includes('eas project') && (blob.includes('not configured') || blob.includes('not found') || blob.includes('not initialized'))
    || blob.includes('projectid') && blob.includes('missing')
    || blob.includes('run `eas init') || blob.includes('run "eas init') || blob.includes('run eas init')
    || blob.includes('entity_not_authorized_error')
    || blob.includes('could not find project')
    || blob.includes('no project with id')
  ) {
    log('');
    log(`${RED}${BOLD}✗ ${_(
      'No EAS project on Expo for this app.',
      "Ce projet n'existe pas sur Expo pour cette app."
    )}${RESET}`);
    log(_(
      `eas-cli refused to write ${BOLD}${name}${RESET} because there's no EAS project to write it on. The project must first be created on ${BOLD}https://expo.dev${RESET} and linked to your local app.json.`,
      `eas-cli a refusé d'écrire ${BOLD}${name}${RESET} parce qu'il n'y a aucun projet EAS sur lequel l'enregistrer. Il faut d'abord créer le projet sur ${BOLD}https://expo.dev${RESET} et le lier à ton app.json local.`,
    ));
    log('');
    log(`${BOLD}${_('Fix:', 'À faire :')}${RESET}`);
    log(`  1) eas login   ${GREY}${_('(if you aren\'t already)', '(si pas déjà fait)')}${RESET}`);
    log(`  2) eas init    ${GREY}${_('— links / creates the EAS project and writes the projectId into app.json', '— lie / crée le projet EAS et écrit le projectId dans app.json')}${RESET}`);
    log(`  3) ${_('Re-run', 'Relance')} ${BOLD}npx pionne setup${RESET}`);
    process.exit(1);
  }

  // Auth issues — separate from "no project" because the fix differs.
  if (blob.includes('not logged in') || blob.includes('eas login') || blob.includes('unauthenticated')) {
    log('');
    log(`${RED}${BOLD}✗ ${_('Not logged in to EAS.', 'Pas connecté à EAS.')}${RESET}`);
    log(`${_('Run', 'Lance')} ${BOLD}eas login${RESET} ${_('then re-run', 'puis relance')} ${BOLD}npx pionne setup${RESET}.`);
    process.exit(1);
  }

  // Quota / plan limits.
  if (blob.includes('limit') && (blob.includes('exceeded') || blob.includes('reached'))) {
    log('');
    log(`${RED}${BOLD}✗ ${_('EAS quota reached on your Expo plan.', 'Quota EAS atteint sur ton plan Expo.')}${RESET}`);
    log(_(
      'Upgrade your plan on https://expo.dev or delete unused environment variables, then retry.',
      'Upgrade ton plan sur https://expo.dev ou supprime des variables inutilisées, puis réessaie.',
    ));
    process.exit(1);
  }

  // Fallback — raw stderr was already streamed to stdout above.
  die(`eas env:create ${name} (${env}) ${_('failed', 'a échoué')}`);
}

function listExistingPionneVars(envs, names, progress) {
  const found = [];
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i];
    if (progress) progress(env, i + 1, envs.length);
    const r = spawnSync(
      'eas',
      ['env:list', '--environment', env, '--format', 'short', '--non-interactive'],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    if (r.status !== 0) continue;
    const out = String(r.stdout || '');
    const present = names.filter((n) => new RegExp(`(^|\\s)${n}(\\s|$)`, 'm').test(out));
    if (present.length) found.push({ env, names: present });
  }
  return found;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Timeout (${timeoutMs / 1000}s) calling ${url}. Vérifie ta connexion ou le serveur.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Identify as the CLI client so the API names the issued Sanctum
      // token 'cli' and revokes any prior CLI token for this user. Keeps
      // the personal_access_tokens table tidy across repeated wizard runs.
      'X-Pionne-Client': 'cli',
    },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

async function getJson(url, token) {
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.json().catch(() => ({}));
}

async function readHidden(prompt = '') {
  // Caller MUST have closed any active readline.Interface before calling
  // this — sharing stdin between a paused rl and a raw-mode listener
  // leaks the typed char on Node 22+/zsh.
  // We force-disable TTY echo at the OS level (`stty -echo`) AND
  // setRawMode(true). Both restored on cleanup.
  output.write(prompt);

  return new Promise((resolve) => {
    let buf = '';
    const isTTY = input.isTTY;
    const wasRaw = input.isRaw;
    let sttyRestored = false;
    const restoreEchoOS = () => {
      if (sttyRestored) return;
      sttyRestored = true;
      try { execSync('stty echo 2>/dev/null'); } catch { /* non-POSIX shell, no-op */ }
    };
    if (isTTY) {
      try { execSync('stty -echo 2>/dev/null'); } catch { /* fall back to setRawMode only */ }
      input.setRawMode(true);
    }
    input.resume();
    input.setEncoding('utf8');

    const cleanup = () => {
      input.removeListener('data', onData);
      if (isTTY) input.setRawMode(wasRaw);
      restoreEchoOS();
      // Pause stdin so the next createInterface() reattaches cleanly
      // without consuming a leftover keystroke.
      input.pause();
    };

    const onData = (chunk) => {
      const c = chunk.toString();
      if (c === '\u0003') { // Ctrl-C
        cleanup();
        output.write('\n');
        process.exit(130);
      }
      if (c === '\n' || c === '\r' || c === '\u0004') {
        cleanup();
        output.write('\n');
        resolve(buf);
        return;
      }
      if (c === '\u007F' || c === '\b') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (c.length === 1 && c.charCodeAt(0) < 32) return;
      buf += c;
      output.write('\u2022');
    };

    input.on('data', onData);
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
