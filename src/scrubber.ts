// PII scrubber — replaces sensitive patterns with placeholders.
// On by default (`scrubPii: true`) to avoid shipping email, card, JWT, IPs,
// IBAN, etc. inside error messages. GDPR-friendly.
//
// Consumers can disable it or add their own patterns via
// `Pionne.init({ scrubPii: false })` or `scrubPii: [{re: ..., replace: ...}]`.

export type ScrubPattern = { re: RegExp; replace: string };

export const DEFAULT_PATTERNS: ScrubPattern[] = [
  // Email
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[EMAIL]' },
  // IBAN (FR..., DE..., etc.) — BEFORE card, otherwise CARD swallows it
  { re: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){3,7}[A-Z0-9]{1,4}\b/g, replace: '[IBAN]' },
  // Credit card (13-19 digits with spaces/dashes)
  { re: /\b(?:\d[ -]*?){13,19}\b/g, replace: '[CARD]' },
  // JWT (eyJ...)
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: '[JWT]' },
  // Bearer / API tokens (sk_, pk_, ghp_, xoxb_, AKIA, pio_live_...)
  { re: /\b(sk|pk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|AKIA|pio_live|pio_setup)_[A-Za-z0-9_-]{16,}\b/g, replace: '[TOKEN]' },
  // IPv4
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replace: '[IP]' },
  // Phone numbers (FR + international, basic)
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
 * Recursive scrub of an object — applies the patterns to every string found
 * at any depth. Does not mutate the original.
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
