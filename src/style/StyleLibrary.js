import { makeStyle } from './Style.js';

/**
 * The hand-tuned materials.
 *
 * These are the live implementation of style selection until a Claude key is
 * wired up (see `ClaudeStylist`), and they stay useful afterwards: they are
 * the offline fallback, and they are the worked examples that show a model
 * what a well-formed style looks like.
 *
 * Two things were tuned for across all of them. Every ramp keeps a real
 * spread from its darkest to its brightest stop, because the ramp is what
 * carries the original shading — flatten it and objects go flat and stop
 * reading as things you could reach for. And `chroma` stays low, because the
 * point is to convincingly replace the material rather than tint it; leaving
 * much of the real colour in makes it look like a filter over a mug instead
 * of a mug made of something else.
 */
const PRESETS = [
  {
    id: 'ice',
    name: 'Carved Ice',
    blurb: 'Everything cut from a single block of glacier.',
    ramp: ['#0b1a26', '#2f5f7a', '#8fc7dd', '#f2fbff'],
    chroma: 0.08,
    contrast: 1.35,
    texture: 'veins',
    textureScale: 34,
    textureStrength: 0.16,
    edgeStrength: 0.3,
    edgeColor: '#cdefff',
    sheen: 0.55,
    sheenColor: '#dff4ff',
  },
  {
    id: 'iron',
    name: 'Cast Iron',
    blurb: 'Heavy, cold, and older than the room.',
    ramp: ['#0a0a0c', '#2b2c30', '#585a60', '#9a9da5'],
    chroma: 0.05,
    contrast: 1.2,
    texture: 'hammered',
    textureScale: 90,
    textureStrength: 0.22,
    edgeStrength: 0.34,
    edgeColor: '#000000',
    sheen: 0.16,
    sheenColor: '#c8ccd6',
  },
  {
    id: 'jade',
    name: 'Carved Jade',
    blurb: 'Cool green stone with the light caught inside it.',
    ramp: ['#04180f', '#155137', '#4d9c6f', '#c9f0d8'],
    chroma: 0.1,
    contrast: 1.28,
    texture: 'veins',
    textureScale: 26,
    textureStrength: 0.2,
    edgeStrength: 0.22,
    edgeColor: '#02120a',
    sheen: 0.42,
    sheenColor: '#e6fff0',
  },
  {
    id: 'bronze',
    name: 'Aged Bronze',
    blurb: 'Cast, polished, and left out in the weather.',
    ramp: ['#160c04', '#5c3512', '#b8823a', '#f6dfae'],
    chroma: 0.12,
    contrast: 1.22,
    texture: 'brushed',
    textureScale: 120,
    textureStrength: 0.15,
    edgeStrength: 0.26,
    edgeColor: '#0d0702',
    sheen: 0.5,
    sheenColor: '#ffe9b8',
  },
  {
    id: 'blueprint',
    name: 'Ink & Paper',
    blurb: 'As though someone drew the room and you stepped inside it.',
    // High-key and desaturated so the ink edges dominate — but with a real
    // spread from end to end. A near-flat ramp reads beautifully as line-work
    // and then falls apart in the headset: outlines alone give you silhouettes
    // without curvature, so surfaces stop reading as reachable solids. The
    // shading has to survive even here.
    ramp: ['#8f9bb3', '#c3cbd9', '#e6ebf3', '#ffffff'],
    chroma: 0.04,
    contrast: 0.75,
    texture: 'grain',
    textureScale: 200,
    textureStrength: 0.07,
    edgeStrength: 0.95,
    edgeColor: '#16233d',
    sheen: 0,
    sheenColor: '#ffffff',
  },
  {
    id: 'neon',
    name: 'Neon Wireframe',
    blurb: 'The dark, with every outline lit from within.',
    // The inverse of the others: a nearly black ramp, with all the
    // information pushed into glowing edges.
    ramp: ['#020207', '#0a0a1c', '#141436', '#22224f'],
    chroma: 0.06,
    contrast: 1.5,
    texture: 'none',
    textureScale: 60,
    textureStrength: 0,
    edgeStrength: 1.0,
    edgeColor: '#4ff0ff',
    sheen: 0.7,
    sheenColor: '#ff5ecf',
  },
  {
    id: 'bone',
    name: 'Old Bone',
    blurb: 'Dry, pale, and slightly porous.',
    ramp: ['#2a2318', '#6d6250', '#c2b69c', '#f6efdf'],
    chroma: 0.07,
    contrast: 1.12,
    texture: 'grain',
    textureScale: 150,
    textureStrength: 0.18,
    edgeStrength: 0.2,
    edgeColor: '#241d12',
    sheen: 0.1,
    sheenColor: '#fffaf0',
  },
  {
    id: 'moss',
    name: 'Long Abandoned',
    blurb: 'Nobody has been in this room for a very long time.',
    ramp: ['#0c1408', '#2f4420', '#6d8b45', '#c3d69a'],
    chroma: 0.14,
    contrast: 1.1,
    texture: 'grain',
    textureScale: 70,
    textureStrength: 0.3,
    edgeStrength: 0.18,
    edgeColor: '#0a1005',
    sheen: 0.06,
    sheenColor: '#e8ffd0',
  },
];

/** Every preset, validated. Built once — styles are immutable in use. */
export const STYLES = PRESETS.map(makeStyle);

export const STYLE_IDS = STYLES.map((s) => s.id);

export function styleById(id) {
  return STYLES.find((s) => s.id === id) || null;
}

export default { STYLES, STYLE_IDS, styleById };
