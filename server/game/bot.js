import { CATEGORIES, WORDS, categoryOf, categoryForText, hintsFor } from '../../public/shared/game/words.js';
import { isOneWord, normalize } from '../../public/shared/game/text.js';

/**
 * The AI opponent.
 *
 * A bot player sits at the table like anyone else and is handed the exact
 * same `Game.viewFor(id)` a human's phone would get — it never sees more
 * than that, which matters as much for a bot as for a person: an AI given
 * the real game state instead of its own redacted view would "play" by
 * cheating, not by being clever.
 *
 * With `ANTHROPIC_API_KEY` set, each decision asks Claude to reason about
 * the hints given so far. Without one, the fallback below leans on the word
 * list's categories instead of a language model: a civilian bot always knows
 * its word's category, so its hints stay on-theme rather than generic; a
 * Mr. White bot does not know the word, but if any hint so far — most
 * reliably a fellow bot's, since it draws from this same vocabulary —
 * matches a category, it borrows that theme too, which is the free
 * approximation of "actually listening to the table." No language
 * understanding is happening; it is a vocabulary lookup. It still beats a
 * bot that answers every round with the same handful of filler words
 * regardless of what anyone said.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 8000;

/** The last resort, when no category could be inferred at all — bland
 *  enough to fit almost anything, which is also what a real Mr. White with
 *  no word and nothing to go on would reach for. */
const FILLER_HINTS = [
  'common', 'everyday', 'familiar', 'useful', 'ordinary', 'simple', 'basic',
  'known', 'typical', 'general', 'plain', 'regular', 'standard', 'shared',
  'popular', 'classic', 'handy', 'small', 'large', 'round', 'square', 'shiny',
  'quiet', 'loud', 'light', 'heavy', 'warm', 'cool', 'soft', 'solid', 'old',
  'modern', 'natural', 'colorful',
];

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function askClaude(system, user) {
  if (!isConfigured()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const block = Array.isArray(data?.content) ? data.content.find((b) => b.type === 'text') : null;
    return block?.text ? block.text.trim() : null;
  } catch {
    // A timeout, a network blip, a bad key — any of these should leave the
    // bot playing on with the fallback rather than stall the table.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function nameOf(view, id) {
  return view.players.find((p) => p.id === id)?.name ?? 'Someone';
}

function transcript(view) {
  if (!view.hints.length) return '(nobody has spoken yet)';
  return view.hints.map((h) => `${nameOf(view, h.playerId)}: ${h.text}`).join('\n');
}

function pickFiller(usedTexts) {
  const pool = FILLER_HINTS.filter((w) => !usedTexts.has(w));
  const list = pool.length ? pool : FILLER_HINTS;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Best guess at what the round is "about," for the free fallback only.
 *
 * A civilian bot already knows the word, so this is exact — no guessing
 * involved. Mr. White does not, so this looks at every hint given so far and
 * checks it against the word list's own vocabulary; whichever category comes
 * up most often is what the bot plays along with. It is a literal-match
 * lookup, not comprehension — most freeform human hints will not match
 * anything — but it means an AI Mr. White's next hint is shaped by what the
 * table has actually said, rather than being deaf to it.
 */
function inferCategory(view) {
  if (view.you.role === 'civilian' && view.word) return categoryOf(view.word);

  const counts = new Map();
  for (const h of view.hints) {
    const cat = categoryForText(h.text);
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [cat, n] of counts) {
    if (n > bestCount) { best = cat; bestCount = n; }
  }
  return best;
}

function pickFallbackHint(view, usedTexts) {
  const category = inferCategory(view);
  const wordNorm = view.word ? normalize(view.word) : null;
  const onTheme = category
    ? hintsFor(category).filter((w) => !usedTexts.has(w) && w !== wordNorm)
    : [];
  return onTheme.length
    ? onTheme[Math.floor(Math.random() * onTheme.length)]
    : pickFiller(usedTexts);
}

/**
 * Vote fallback: if a theme could be inferred (always, for a civilian; only
 * sometimes, for Mr. White), prefer whoever's most recent hint does *not*
 * match it — an off-theme hint is real, if weak, evidence. With no theme to
 * go on, or nobody off-theme, it falls back to picking anyone at random
 * rather than inventing a signal that is not there.
 */
function pickFallbackVote(view, candidates) {
  const category = inferCategory(view);
  if (category) {
    const offTheme = candidates.filter((p) => {
      const last = [...view.hints].reverse().find((h) => h.playerId === p.id);
      return last && categoryForText(last.text) !== category;
    });
    if (offTheme.length) return offTheme[Math.floor(Math.random() * offTheme.length)].id;
  }
  return candidates[Math.floor(Math.random() * candidates.length)].id;
}

function pickFallbackGuess(view) {
  const category = inferCategory(view);
  const pool = category ? CATEGORIES[category].words : WORDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * One word, guaranteed legal: unused this round, and — for a civilian bot —
 * never the secret word itself. `Game.submitHint` is the real referee, this
 * just makes sure the bot does not hand it a hint doomed to be rejected.
 */
export async function chooseHint(view) {
  const usedTexts = new Set(view.hints.map((h) => h.text));
  const isWhite = view.you.role === 'mrwhite';

  const system = isWhite
    ? 'You are playing Mr. White, a party word-guessing game. You have NOT '
      + 'been told the secret word — invent a plausible one-word hint that '
      + 'could fit many different words, based only on what others have '
      + 'hinted so far, so you blend in without being caught. Reply with '
      + 'ONLY the single hint word — no punctuation, no explanation.'
    : `You are playing Mr. White, a party word-guessing game. The secret `
      + `word is "${view.word}". Give a one-word hint that points at it `
      + 'without ever saying the word itself, a direct synonym of it, or '
      + 'repeating a word already used this round. Reply with ONLY the '
      + 'single hint word — no punctuation, no explanation.';
  const user = `Hints given so far, in order:\n${transcript(view)}\n\nGive your one-word hint now.`;

  const raw = await askClaude(system, user);
  const clean = raw ? normalize(raw).split(/\s+/)[0] : null;
  const ok = clean && isOneWord(clean) && !usedTexts.has(clean)
    && (isWhite || clean !== normalize(view.word));
  return ok ? clean : pickFallbackHint(view, usedTexts);
}

/** A candidate id to vote for, or null if there is nobody left to vote for. */
export async function chooseVote(view) {
  const candidates = view.players.filter((p) => p.playing && p.alive && p.id !== view.you.id);
  if (candidates.length === 0) return null;

  const list = candidates.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const system = view.you.role === 'mrwhite'
    ? 'You are secretly Mr. White in the party game Mr. White, and must not '
      + 'get caught. Vote for whichever other player seems safest for you to '
      + 'accuse — someone whose hint was vague or who others already '
      + 'suspect. Reply with ONLY the number of your chosen player.'
    : 'You are a civilian in the party game Mr. White, trying to catch the '
      + 'impostor who has been giving vague or off hints with no real idea '
      + 'of the word. Reply with ONLY the number of the player you suspect.';
  const user = `Hints given so far:\n${transcript(view)}\n\nCandidates:\n${list}\n\nWho do you vote for? Reply with just the number.`;

  const raw = await askClaude(system, user);
  const n = raw ? parseInt(raw.match(/\d+/)?.[0] ?? '', 10) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return candidates[n - 1].id;
  return pickFallbackVote(view, candidates);
}

/** The bot's one guess after being caught as Mr. White. Always some word. */
export async function chooseGuess(view) {
  const system = 'You were just caught as Mr. White in the party game Mr. '
    + 'White. You get one guess at the secret word, based only on the hints '
    + 'everyone gave this round. Reply with ONLY your single best guess.';
  const user = `Hints given during the round:\n${transcript(view)}\n\nWhat is your guess?`;

  const raw = await askClaude(system, user);
  const clean = raw ? normalize(raw).split(/\s+/)[0] : null;
  return clean && isOneWord(clean) ? clean : pickFallbackGuess(view);
}

export default { isConfigured, chooseHint, chooseVote, chooseGuess };
