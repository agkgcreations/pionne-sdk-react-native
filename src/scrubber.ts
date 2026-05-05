// PII scrubber — remplace les patterns sensibles par des placeholders.
// Activé par défaut (`scrubPii: true`) pour éviter d'envoyer email, CB, JWT,
// IPs, IBAN, etc. dans les messages d'erreur. RGPD-friendly.
//
// L'utilisateur peut désactiver ou ajouter ses propres patterns via
// `Pionne.init({ scrubPii: false })` ou `scrubPii: [{re: ..., replace: ...}]`.

export type ScrubPattern = { re: RegExp; replace: string };

export const DEFAULT_PATTERNS: ScrubPattern[] = [
  // Email
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[EMAIL]' },
  // IBAN (FR..., DE..., etc.) — AVANT card, sinon CARD le mange
  { re: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/g, replace: '[IBAN]' },
  // Carte bancaire (13-19 chiffres avec espaces/tirets)
  { re: /\b(?:\d[ -]*?){13,19}\b/g, replace: '[CARD]' },
  // JWT (eyJ...)
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: '[JWT]' },
  // Bearer / API tokens (sk_, pk_, ghp_, xoxb_, AKIA, pio_live_...)
  { re: /\b(sk|pk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|AKIA|pio_live|pio_setup)_[A-Za-z0-9_-]{16,}\b/g, replace: '[TOKEN]' },
  // IPv4
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replace: '[IP]' },
  // Numéros de téléphone (FR + international, basique)
  { re: /\b(?:\+\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{2,4}[ -]?\d{2,4}[ -]?\d{2,4}[ -]?\d{2,4}\b/g, replace: '[PHONE]' },
];

export function scrubString(input: string, patterns: ScrubPattern[]): string {
  let out = input;
  for (const { re, replace } of patterns) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Scrub récursif d'un objet — applique les patterns sur toutes les strings
 * trouvées en profondeur. Mute pas l'original.
 */
export function scrubDeep(value: unknown, patterns: ScrubPattern[]): unknown {
  if (typeof value === 'string') return scrubString(value, patterns);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, patterns));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, patterns);
    }
    return out;
  }
  return value;
}
