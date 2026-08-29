/**
 * The words, grouped by category.
 *
 * Picking these is a game-design job, not a data-entry one. A word earns its
 * place by being:
 *
 * - **Concrete.** You can point at a piano. You cannot point at "justice", and
 *   a table given an abstract noun produces four hints that are all just
 *   synonyms for it, which tells Mr. White everything at once.
 * - **Widely known.** Anything that depends on where you grew up or what you
 *   studied stops being a deduction game and starts being a trivia one.
 * - **Rich in associations.** The hints have to be able to circle a word
 *   without landing on it. "Piano" has keys, black, white, tuning, stool,
 *   loud, heavy, lessons. A word with only one association forces the first
 *   speaker to hand it over.
 * - **Not so specific it is one hint from being solved.** "Stethoscope" is
 *   really only "doctor". "Hospital" opens out in a dozen directions.
 *
 * Spelling is the flat, common form, so nobody loses a guess to a variant.
 *
 * The grouping into categories exists for a second reason beyond organizing
 * this file: it is what lets an AI player *without* access to a language
 * model still give a hint that is about the right kind of thing — "indoor"
 * for a pillow, never a bare word plucked at random — and lean on whichever
 * category the hints already given seem to be circling, when it does not
 * know the word itself. See `server/game/bot.js`.
 */
export const CATEGORIES = {
  house: {
    hints: ['indoor', 'household', 'everyday', 'domestic', 'handy', 'roomy'],
    words: [
      'pillow', 'mirror', 'kettle', 'ladder', 'umbrella', 'blanket', 'candle',
      'curtain', 'drawer', 'mattress', 'doorbell', 'chimney', 'staircase',
      'balcony', 'wardrobe', 'toaster', 'fridge', 'oven', 'shower', 'bathtub',
      'towel', 'toothbrush', 'razor', 'clock', 'lamp', 'carpet', 'ceiling',
      'basement', 'garage', 'fence', 'mailbox', 'hammer', 'rope', 'bucket',
      'broom', 'laundry', 'garden',
    ],
  },
  food: {
    hints: ['edible', 'tasty', 'kitchen', 'snack', 'savory', 'meal'],
    words: [
      'pizza', 'popcorn', 'pancake', 'honey', 'chocolate', 'cheese', 'bread',
      'butter', 'coffee', 'sugar', 'lemon', 'banana', 'watermelon', 'strawberry',
      'pineapple', 'mushroom', 'onion', 'garlic', 'noodles', 'soup', 'sandwich',
      'burger', 'sundae', 'cake', 'cookie', 'donut', 'yogurt', 'cereal', 'bacon',
      'ketchup', 'vinegar', 'barbecue', 'picnic',
    ],
  },
  animals: {
    hints: ['wild', 'creature', 'nature', 'safari', 'species', 'furry'],
    words: [
      'penguin', 'elephant', 'giraffe', 'dolphin', 'octopus', 'butterfly',
      'spider', 'snake', 'owl', 'eagle', 'shark', 'whale', 'kangaroo', 'camel',
      'hedgehog', 'squirrel', 'rabbit', 'turtle', 'frog', 'bee', 'mosquito',
      'parrot', 'peacock', 'crocodile', 'hamster',
    ],
  },
  places: {
    hints: ['destination', 'landmark', 'building', 'visit', 'location', 'outing'],
    words: [
      'airport', 'library', 'hospital', 'museum', 'beach', 'desert', 'jungle',
      'mountain', 'volcano', 'island', 'cave', 'bridge', 'tunnel', 'castle',
      'stadium', 'theatre', 'restaurant', 'hotel', 'prison', 'school', 'farm',
      'zoo', 'market', 'lighthouse', 'playground', 'bakery', 'pharmacy',
      'aquarium', 'campsite',
    ],
  },
  transport: {
    hints: ['vehicle', 'transport', 'wheels', 'travel', 'ride', 'moving'],
    words: [
      'bicycle', 'motorcycle', 'helicopter', 'submarine', 'rocket', 'tractor',
      'ambulance', 'taxi', 'subway', 'ferry', 'skateboard', 'scooter',
      'parachute', 'elevator', 'escalator', 'sailboat', 'canoe', 'balloon',
    ],
  },
  weather: {
    hints: ['sky', 'weather', 'natural', 'outdoor', 'phenomenon', 'seasonal'],
    words: [
      'rainbow', 'thunder', 'lightning', 'snowflake', 'glacier', 'waterfall',
      'earthquake', 'tornado', 'sunset', 'eclipse', 'comet', 'planet', 'moon',
      'cloud', 'fog', 'avalanche',
    ],
  },
  activities: {
    hints: ['hobby', 'sport', 'exercise', 'pastime', 'fun', 'active'],
    words: [
      'swimming', 'camping', 'fishing', 'chess', 'football', 'basketball',
      'tennis', 'boxing', 'marathon', 'yoga', 'dancing', 'karaoke', 'bowling',
      'surfing', 'skiing', 'hiking', 'juggling', 'puzzle', 'archery',
    ],
  },
  gadgets: {
    hints: ['device', 'gadget', 'electronic', 'tech', 'modern', 'wireless'],
    words: [
      'keyboard', 'headphones', 'camera', 'printer', 'battery', 'password',
      'robot', 'drone', 'telescope', 'microscope', 'satellite', 'calculator',
      'flashlight', 'magnet', 'compass', 'binoculars',
    ],
  },
  wearables: {
    hints: ['clothing', 'wearable', 'accessory', 'outfit', 'fashion', 'worn'],
    words: [
      'sunglasses', 'scarf', 'gloves', 'helmet', 'boots', 'pyjamas', 'backpack',
      'wallet', 'necklace', 'apron', 'raincoat', 'sandals', 'tuxedo', 'uniform',
      'suitcase',
    ],
  },
  entertainment: {
    hints: ['performance', 'celebration', 'event', 'show', 'festive', 'live'],
    words: [
      'circus', 'magician', 'orchestra', 'guitar', 'piano', 'drums', 'violin',
      'cinema', 'cartoon', 'comic', 'novel', 'birthday', 'wedding', 'parade',
      'festival', 'fireworks', 'carnival', 'trophy',
    ],
  },
  jobs: {
    hints: ['profession', 'worker', 'career', 'skilled', 'trained', 'staff'],
    words: [
      'dentist', 'firefighter', 'astronaut', 'pilot', 'chef', 'farmer',
      'plumber', 'teacher', 'nurse', 'detective', 'lifeguard', 'barber',
      'clown', 'waiter', 'referee',
    ],
  },
  abstract: {
    hints: ['invisible', 'intangible', 'feeling', 'concept', 'unseen', 'mysterious'],
    words: [
      'shadow', 'echo', 'dream', 'ghost', 'secret', 'gravity', 'silence',
      'homework', 'traffic', 'alarm', 'nightmare', 'holiday',
    ],
  },
};

export const WORDS = Object.values(CATEGORIES).flatMap((c) => c.words);

const WORD_CATEGORY = new Map();
const VOCAB_CATEGORY = new Map();
for (const [key, { hints, words }] of Object.entries(CATEGORIES)) {
  for (const w of words) WORD_CATEGORY.set(w, key);
  for (const w of [...hints, ...words]) VOCAB_CATEGORY.set(w, key);
}

/** Which category a real word from the list belongs to, or null. */
export function categoryOf(word) {
  return WORD_CATEGORY.get(String(word ?? '').trim().toLowerCase()) ?? null;
}

/**
 * Which category a piece of free text — a hint someone gave — suggests, by
 * literal match against every category's words and hint vocabulary. Most
 * human hints will not match anything here; there is no real language
 * understanding behind it. But it is the one signal available for free, and
 * it reliably catches another AI player's hint, since those are drawn from
 * this exact vocabulary — which is what lets an AI Mr. White converge on the
 * theme its own table has already established.
 */
export function categoryForText(text) {
  return VOCAB_CATEGORY.get(String(text ?? '').trim().toLowerCase()) ?? null;
}

/** The hint vocabulary for one category: plausible one-word hints that
 *  don't give away any specific word in it. */
export function hintsFor(category) {
  return CATEGORIES[category]?.hints ?? [];
}

/**
 * Pick a word the table has not had yet.
 *
 * Once the list is exhausted it starts over rather than failing — a group that
 * has played two hundred rounds in one sitting has earned a repeat, and
 * running out of words is not a reason to stop the game.
 */
export function drawWord(used = new Set(), rng = Math.random) {
  const unused = WORDS.filter((w) => !used.has(w));
  const pool = unused.length ? unused : WORDS;
  return pool[Math.floor(rng() * pool.length)];
}

export default { CATEGORIES, WORDS, categoryOf, categoryForText, hintsFor, drawWord };
