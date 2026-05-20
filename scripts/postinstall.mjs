#!/usr/bin/env node
//
// Affiché à l'install du package. Aucun effet de bord (pas d'écriture de
// fichiers chez l'user, pas d'appel réseau, pas de prompt) — pour ne jamais
// casser un build CI ou un install transitive.
//

// Skip si on est dans un install transitive (= pas le dossier où l'user a
// lancé `npm i @pionne/react-native`).
const initCwd = process.env.INIT_CWD;
const installPath = process.env.npm_package_root || '';
if (!initCwd || initCwd.includes('node_modules/')) {
  process.exit(0);
}

// Skip aussi si CI (pas la peine de polluer les logs).
if (process.env.CI) process.exit(0);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const VIOLET = '\x1b[38;5;105m';
const GREY = '\x1b[90m';

const lines = [
  '',
  `${VIOLET}${BOLD}  📡 Pionne installed.${RESET}`,
  '',
  `  ${BOLD}1. Configure auto-upload sourcemaps (optionnel, 30 sec):${RESET}`,
  `     ${VIOLET}npx @pionne/react-native setup${RESET}`,
  '',
  `  ${BOLD}2. Init dans App.tsx:${RESET}`,
  `     ${GREY}import { Pionne } from '@pionne/react-native';${RESET}`,
  `     ${GREY}Pionne.init({ token: 'pio_live_xxx' });${RESET}`,
  '',
  `  ${GREY}Docs: https://pionne.agkgcreations.fr/docs${RESET}`,
  '',
];
console.log(lines.join('\n'));
