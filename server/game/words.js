/**
 * The words.
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
 */
export const WORDS = [
  // Around the house
  'pillow', 'mirror', 'kettle', 'ladder', 'umbrella', 'blanket', 'candle',
  'curtain', 'drawer', 'mattress', 'doorbell', 'chimney', 'staircase',
  'balcony', 'wardrobe', 'toaster', 'fridge', 'oven', 'shower', 'bathtub',
  'towel', 'toothbrush', 'razor', 'clock', 'lamp', 'carpet', 'ceiling',
  'basement', 'garage', 'fence', 'mailbox', 'hammer', 'rope', 'bucket',
  'broom', 'laundry', 'garden',

  // Food and drink
  'pizza', 'popcorn', 'pancake', 'honey', 'chocolate', 'cheese', 'bread',
  'butter', 'coffee', 'sugar', 'lemon', 'banana', 'watermelon', 'strawberry',
  'pineapple', 'mushroom', 'onion', 'garlic', 'noodles', 'soup', 'sandwich',
  'burger', 'sundae', 'cake', 'cookie', 'donut', 'yogurt', 'cereal', 'bacon',
  'ketchup', 'vinegar', 'barbecue', 'picnic',

  // Animals
  'penguin', 'elephant', 'giraffe', 'dolphin', 'octopus', 'butterfly',
  'spider', 'snake', 'owl', 'eagle', 'shark', 'whale', 'kangaroo', 'camel',
  'hedgehog', 'squirrel', 'rabbit', 'turtle', 'frog', 'bee', 'mosquito',
  'parrot', 'peacock', 'crocodile', 'hamster',

  // Places
  'airport', 'library', 'hospital', 'museum', 'beach', 'desert', 'jungle',
  'mountain', 'volcano', 'island', 'cave', 'bridge', 'tunnel', 'castle',
  'stadium', 'theatre', 'restaurant', 'hotel', 'prison', 'school', 'farm',
  'zoo', 'market', 'lighthouse', 'playground', 'bakery', 'pharmacy',
  'aquarium', 'campsite',

  // Getting about
  'bicycle', 'motorcycle', 'helicopter', 'submarine', 'rocket', 'tractor',
  'ambulance', 'taxi', 'subway', 'ferry', 'skateboard', 'scooter',
  'parachute', 'elevator', 'escalator', 'sailboat', 'canoe', 'balloon',

  // Weather and the sky
  'rainbow', 'thunder', 'lightning', 'snowflake', 'glacier', 'waterfall',
  'earthquake', 'tornado', 'sunset', 'eclipse', 'comet', 'planet', 'moon',
  'cloud', 'fog', 'avalanche',

  // Things people do
  'swimming', 'camping', 'fishing', 'chess', 'football', 'basketball',
  'tennis', 'boxing', 'marathon', 'yoga', 'dancing', 'karaoke', 'bowling',
  'surfing', 'skiing', 'hiking', 'juggling', 'puzzle', 'archery',

  // Gadgets and tools
  'keyboard', 'headphones', 'camera', 'printer', 'battery', 'password',
  'robot', 'drone', 'telescope', 'microscope', 'satellite', 'calculator',
  'flashlight', 'magnet', 'compass', 'binoculars',

  // What people wear and carry
  'sunglasses', 'scarf', 'gloves', 'helmet', 'boots', 'pyjamas', 'backpack',
  'wallet', 'necklace', 'apron', 'raincoat', 'sandals', 'tuxedo', 'uniform',
  'suitcase',

  // Music, stories, occasions
  'circus', 'magician', 'orchestra', 'guitar', 'piano', 'drums', 'violin',
  'cinema', 'cartoon', 'comic', 'novel', 'birthday', 'wedding', 'parade',
  'festival', 'fireworks', 'carnival', 'trophy',

  // People at work
  'dentist', 'firefighter', 'astronaut', 'pilot', 'chef', 'farmer',
  'plumber', 'teacher', 'nurse', 'detective', 'lifeguard', 'barber',
  'clown', 'waiter', 'referee',

  // Things without a shape, that still have plenty to say about them
  'shadow', 'echo', 'dream', 'ghost', 'secret', 'gravity', 'silence',
  'homework', 'traffic', 'alarm', 'nightmare', 'holiday',
];

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

export default { WORDS, drawWord };
