/** Small text rules, kept apart so the tests can hammer them directly. */

/** Lowercase, trimmed, inner whitespace collapsed. */
export function normalize(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A hint is exactly one word.
 *
 * Letters (in any script), digits, and the apostrophes and hyphens that live
 * inside real words. No spaces — the one-word rule is what makes the game
 * hard, and "a thing you sit on" would end it instantly.
 */
const ONE_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]{0,19}$/u;

export function isOneWord(text) {
  return ONE_WORD.test(normalize(text));
}

/**
 * Does this guess match the secret word?
 *
 * Deliberately forgiving. Mr. White typing "glasses" when the word was
 * "glass" has *won* — they worked it out from hints alone, which is the
 * hardest thing in the game — and losing that on a plural would be
 * infuriating. So punctuation and case are ignored, and a trailing plural on
 * either side counts.
 *
 * It is not fuzzy beyond that: a near-miss synonym is a miss, because
 * deciding how near is near enough is exactly the argument this should not
 * be having.
 */
export function sameWord(a, b) {
  const clean = (s) => normalize(s).replace(/[^\p{L}\p{N}]/gu, '');
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return y === `${x}s` || y === `${x}es` || x === `${y}s` || x === `${y}es`;
}

export default { normalize, isOneWord, sameWord };
