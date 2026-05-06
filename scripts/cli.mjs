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

  const cwd = process.env.INIT_CWD || process.cwd();
  if (!existsSync(join(cwd, 'app.json')) && !existsSync(join(cwd, 'package.json'))) {
    die(`Run this command from the root of your Expo project (where app.json lives).`);
  }

  // 1. Vérifie eas-cli
  if (!hasCommand('eas')) {
    warn(`eas-cli not installed. Run: npm install -g eas-cli`);
    return;
  }

  let easUser;
  try {
    easUser = execSync('eas whoami', { stdio: 'pipe' }).toString().trim();
    ok(`Logged into EAS: ${easUser}`);
  } catch {
    warn(`Not logged into EAS. Run: eas login`);
    return;
  }

  // 2. Login Pionne
  const api = process.env.PIONNE_API || 'https://pionne.agkgcreations.fr/api';
  const rl = createInterface({ input, output });

  const email = await rl.question(`Pionne email: `);
  // Hide stdin during password input.
  const password = await readHidden(rl, `Pionne password: `);

  log(`${YELLOW}→ Logging in to ${api}...${RESET}`);
  let loginRes;
  try {
    loginRes = await postJson(`${api}/auth/login`, { email, password });
  } catch (e) {
    die(`Network error: ${e.message}`);
  }

  // Two-factor auth — server asks for a TOTP code as a second step.
  if (loginRes?.requires_totp && loginRes.totp_token) {
    log(`${GREEN}✓${RESET} Password OK — 2FA required.`);
    const totpInput = (await rl.question(`2FA code (6 digits) or recovery code: `)).trim();
    if (!totpInput) die('No 2FA code provided.');
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
    die(`Login failed: ${JSON.stringify(loginRes)}`);
  }
  const authToken = loginRes.token;
  ok(`Login OK`);

  // 3. List projects
  log(`${YELLOW}→ Fetching projects...${RESET}`);
  const { projects = [] } = await getJson(`${api}/projects`, authToken);
  if (!projects.length) {
    die(`No projects yet. Create one in the Pionne mobile app first.`);
  }

  let projectId;
  if (projects.length === 1) {
    projectId = projects[0].id;
    ok(`Single project, auto-selected: [id=${projectId}] ${projects[0].name}`);
  } else {
    log('');
    projects.forEach((p, i) => {
      log(`  ${i + 1}) [id=${p.id}] ${p.name} (${p.platform})`);
    });
    log('');
    const idx = await rl.question(`Project number: `);
    projectId = projects[parseInt(idx, 10) - 1]?.id;
    if (!projectId) die(`Invalid number.`);
  }

  // 4. Confirm + create EAS Secrets
  log(``);
  log(`${BOLD}EAS environment variables to set:${RESET}`);
  log(`  PIONNE_AUTH_TOKEN  = ${authToken.slice(0, 20)}...`);
  log(`  PIONNE_PROJECT_ID  = ${projectId}`);
  log(`  PIONNE_API         = ${api}`);
  log(``);

  const confirm = await rl.question(`Confirm (y/N)? `);
  rl.close();
  if (confirm.toLowerCase() !== 'y') {
    log(`Cancelled.`);
    return;
  }

  // EAS migrated `eas secret:*` → `eas env:*` (env vars per environment).
  // We push to the three standard environments so the hook works whichever
  // build profile the user picks (development / preview / production).
  const envs = ['production', 'preview', 'development'];
  const entries = [
    ['PIONNE_AUTH_TOKEN', authToken],
    ['PIONNE_PROJECT_ID', String(projectId)],
    ['PIONNE_API', api],
  ];

  for (const env of envs) {
    for (const [name] of entries) {
      // Best-effort delete — silent if it doesn't exist yet.
      spawnSync(
        'eas',
        ['env:delete', '--variable-name', name, '--variable-environment', env, '--non-interactive'],
        { stdio: 'ignore' },
      );
    }
  }

  for (const env of envs) {
    for (const [name, value] of entries) {
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
        { stdio: 'inherit' },
      );
      if (r.status !== 0) die(`eas env:create ${name} (${env}) failed`);
    }
  }

  // 5. Install eas-build-on-success.sh
  const hookPath = join(cwd, 'eas-build-on-success.sh');
  const hookContents = readPackageFile('templates/eas-build-on-success.sh');
  if (existsSync(hookPath)) {
    warn(`eas-build-on-success.sh already exists — not overwritten.`);
  } else {
    writeFileSync(hookPath, hookContents, { mode: 0o755 });
    ok(`EAS hook written: eas-build-on-success.sh`);
  }

  log(`\n${GREEN}${BOLD}✓ Setup done.${RESET}`);
  log(`From now on, every ${BOLD}eas build${RESET} will upload its sourcemaps automatically.`);

  // Final verification — list the production env vars so the user sees them
  // confirmed without having to type the command themselves. Read-only, the
  // `secret` visibility ensures values stay masked.
  log(`\n${YELLOW}→ Verifying — EAS env vars (production):${RESET}`);
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
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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

async function readHidden(rl, prompt = '') {
  // Pause readline so it stops handling stdin (and stops echoing). We take
  // over the keystrokes ourselves in raw mode and resume readline at the end.
  // This pattern is what npm CLI uses for password prompts and works across
  // every Node version (readline.question + _writeToOutput is fragile from
  // Node 22+, where TTY echo bypasses _writeToOutput).
  rl.pause();
  output.write(prompt);

  return new Promise((resolve) => {
    let buf = '';
    const isTTY = input.isTTY;
    const wasRaw = input.isRaw;
    if (isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const cleanup = () => {
      input.removeListener('data', onData);
      if (isTTY) input.setRawMode(wasRaw);
      // Resume readline for subsequent prompts.
      rl.resume();
    };

    const onData = (chunk) => {
      const c = chunk.toString();
      // Ctrl-C — abort cleanly.
      if (c === '\u0003') {
        cleanup();
        output.write('\n');
        process.exit(130);
      }
      // Enter / Ctrl-D — done.
      if (c === '\n' || c === '\r' || c === '\u0004') {
        cleanup();
        output.write('\n');
        resolve(buf);
        return;
      }
      // Backspace (DEL or BS).
      if (c === '\u007F' || c === '\b') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      // Ignore other control chars.
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
