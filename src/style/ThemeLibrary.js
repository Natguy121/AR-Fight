import { makeTheme } from './Theme.js';

/**
 * The hand-authored worlds.
 *
 * Each one is a base material for the room plus a deliberate answer to "and
 * what does the TV become?" for every object the segmenter can recognise.
 * Those per-object answers are the whole point — they are what makes this a
 * place rather than a tint.
 *
 * The one that shows the mechanism best is the whiteboard. A TV is a dark
 * rectangle full of detail; give it a near-white ramp and a very strong dark
 * edge pass and its own picture is redrawn as marker strokes on a white
 * board. Nothing is pasted over it — the screen's actual content becomes the
 * scribble, so it lines up perfectly and changes when the picture does.
 */
const THEMES = [
  {
    id: 'workshop',
    name: 'The Workshop',
    blurb: 'Bare plaster and steel. The TV is a whiteboard now.',
    base: {
      ramp: ['#2b2a26', '#6a6760', '#a9a49a', '#e8e4da'],
      chroma: 0.06, contrast: 1.1,
      texture: 'grain', textureScale: 170, textureStrength: 0.14,
      edgeStrength: 0.2, edgeColor: '#1a1815',
      sheen: 0.05, sheenColor: '#fffdf6',
    },
    objects: {
      tv: {
        // The whiteboard. Flat and bright, with the screen's own contrast
        // pushed hard into dark outlines — which is what reads as marker.
        ramp: ['#c9ccd4', '#eef0f4', '#f8f9fb', '#ffffff'],
        chroma: 0.02, contrast: 0.7,
        texture: 'none', textureStrength: 0,
        edgeStrength: 1.0, edgeColor: '#1b2740',
        sheen: 0.08, sheenColor: '#ffffff',
      },
      chair: {
        ramp: ['#2a1a0d', '#6b4522', '#a97542', '#e0bd8c'],
        chroma: 0.1, contrast: 1.2,
        texture: 'brushed', textureScale: 130, textureStrength: 0.22,
        edgeStrength: 0.28, edgeColor: '#180f06',
        sheen: 0.14, sheenColor: '#ffe6bd',
      },
      sofa: {
        ramp: ['#171a1e', '#3b444e', '#6b7887', '#b3c0cd'],
        chroma: 0.07, contrast: 1.15,
        texture: 'weave', textureScale: 220, textureStrength: 0.2,
        edgeStrength: 0.22, edgeColor: '#0b0d10',
        sheen: 0.04, sheenColor: '#dfe8f2',
      },
      'dining table': {
        ramp: ['#14161a', '#3d434c', '#79818d', '#c2cad4'],
        chroma: 0.05, contrast: 1.25,
        texture: 'brushed', textureScale: 150, textureStrength: 0.18,
        edgeStrength: 0.3, edgeColor: '#0a0c0f',
        sheen: 0.45, sheenColor: '#eaf1f8',
      },
    },
  },
  {
    id: 'arcade',
    name: 'After Hours Arcade',
    blurb: 'Dark room, neon edges, and the couch is where you game.',
    base: {
      ramp: ['#05050e', '#111133', '#1e1e52', '#33337d'],
      chroma: 0.05, contrast: 1.45,
      texture: 'none', textureStrength: 0,
      edgeStrength: 0.85, edgeColor: '#3ef0ff',
      sheen: 0.35, sheenColor: '#ff5ecf',
    },
    objects: {
      tv: {
        // A CRT still on in a dark room: bright, saturated, blooming.
        ramp: ['#04121a', '#0d4a63', '#22b7d8', '#ccfaff'],
        chroma: 0.55, contrast: 1.5,
        texture: 'brushed', textureScale: 380, textureStrength: 0.12,
        edgeStrength: 0.2, edgeColor: '#8ff6ff',
        sheen: 0.9, sheenColor: '#b6f4ff',
      },
      // In a room this dark, the lit things are the furniture — so these are
      // brighter than the walls, not just outlined differently. Trim alone
      // only shows up where there is edge detail; the broad flat middle of a
      // couch shows nothing but its ramp, and if that matches the wall the
      // whole effect collapses back into a tint.
      sofa: {
        // The gaming couch, lit magenta from underneath.
        ramp: ['#1a0614', '#5c1240', '#a82b72', '#f07ab0'],
        chroma: 0.06, contrast: 1.3,
        texture: 'weave', textureScale: 240, textureStrength: 0.16,
        edgeStrength: 1.0, edgeColor: '#ff3ea8',
        sheen: 0.5, sheenColor: '#ff8ad0',
      },
      chair: {
        // The stool at the cabinet, under its green marquee light.
        ramp: ['#03170c', '#0e5432', '#22b06c', '#8ff5bd'],
        chroma: 0.05, contrast: 1.3,
        texture: 'hammered', textureScale: 110, textureStrength: 0.18,
        edgeStrength: 0.9, edgeColor: '#39ff9e',
        sheen: 0.4, sheenColor: '#39ff9e',
      },
      'dining table': {
        // A cocktail cabinet: amber glass with the game glowing up through it.
        ramp: ['#170a00', '#4d2600', '#9c5b0d', '#ffc46b'],
        chroma: 0.06, contrast: 1.4,
        texture: 'none', textureStrength: 0,
        edgeStrength: 0.7, edgeColor: '#ffb03e',
        sheen: 0.7, sheenColor: '#ffd79a',
      },
    },
  },
  {
    id: 'overgrown',
    name: 'Long Abandoned',
    blurb: 'Nobody has been here in years. Something is growing on the sofa.',
    base: {
      ramp: ['#0e1109', '#333c22', '#6e7c48', '#c3cea0'],
      chroma: 0.12, contrast: 1.1,
      texture: 'grain', textureScale: 80, textureStrength: 0.3,
      edgeStrength: 0.18, edgeColor: '#0a0d05',
      sheen: 0.05, sheenColor: '#e8ffd0',
    },
    objects: {
      tv: {
        // Dead glass: dark, cracked, reflecting nothing.
        ramp: ['#080a0b', '#1b2124', '#333f45', '#5b6d76'],
        chroma: 0.03, contrast: 1.5,
        texture: 'veins', textureScale: 70, textureStrength: 0.35,
        edgeStrength: 0.6, edgeColor: '#04070a',
        sheen: 0.3, sheenColor: '#9fc4d6',
      },
      sofa: {
        // Wet, thriving growth against the room's dry dust — the difference
        // has to be obvious, or the sofa just looks like more wall.
        ramp: ['#01090b', '#0a3a22', '#1f7d3f', '#79d98a'],
        chroma: 0.2, contrast: 1.25,
        texture: 'grain', textureScale: 45, textureStrength: 0.5,
        edgeStrength: 0.3, edgeColor: '#01120a',
        sheen: 0.18, sheenColor: '#c8ffd4',
      },
      chair: {
        // Charred, rotted wood — near-black against the dusty green room.
        ramp: ['#0a0705', '#241a12', '#463424', '#7d6248'],
        chroma: 0.08, contrast: 1.3,
        texture: 'brushed', textureScale: 80, textureStrength: 0.4,
        edgeStrength: 0.35, edgeColor: '#050302',
        sheen: 0.03, sheenColor: '#e8dcc0',
      },
      'potted plant': {
        // The one thing thriving.
        ramp: ['#04160a', '#12551f', '#33a445', '#a8f0a0'],
        chroma: 0.3, contrast: 1.2,
        texture: 'grain', textureScale: 100, textureStrength: 0.25,
        edgeStrength: 0.16, edgeColor: '#031006',
        sheen: 0.12, sheenColor: '#ddffd0',
      },
    },
  },
  {
    id: 'icepalace',
    name: 'The Ice Palace',
    blurb: 'Everything cut from a glacier — and the screen is a frozen window.',
    base: {
      ramp: ['#0b1a26', '#2f5f7a', '#8fc7dd', '#f2fbff'],
      chroma: 0.08, contrast: 1.35,
      texture: 'veins', textureScale: 34, textureStrength: 0.16,
      edgeStrength: 0.3, edgeColor: '#cdefff',
      sheen: 0.55, sheenColor: '#dff4ff',
    },
    objects: {
      tv: {
        ramp: ['#0d2230', '#3d7f9c', '#a5dcef', '#ffffff'],
        chroma: 0.05, contrast: 1.1,
        texture: 'veins', textureScale: 90, textureStrength: 0.3,
        edgeStrength: 0.75, edgeColor: '#e8fbff',
        sheen: 0.85, sheenColor: '#ffffff',
      },
      sofa: {
        // Deep drifted snow: pale and matte, against the room's dark
        // translucent ice. Opaque where everything else is glassy.
        ramp: ['#5d7a8c', '#9fbecd', '#d5e9f2', '#ffffff'],
        chroma: 0.04, contrast: 0.95,
        texture: 'grain', textureScale: 120, textureStrength: 0.28,
        edgeStrength: 0.12, edgeColor: '#7f9aab',
        sheen: 0.12, sheenColor: '#ffffff',
      },
      chair: {
        ramp: ['#08131c', '#1f4760', '#6ba3bd', '#dbf2fb'],
        chroma: 0.05, contrast: 1.4,
        texture: 'veins', textureScale: 46, textureStrength: 0.22,
        edgeStrength: 0.4, edgeColor: '#d8f4ff',
        sheen: 0.6, sheenColor: '#ffffff',
      },
    },
  },
  {
    id: 'foundry',
    name: 'The Foundry',
    blurb: 'Cast iron and hot bronze. The screen is a furnace door.',
    base: {
      ramp: ['#0a0a0c', '#2b2c30', '#585a60', '#9a9da5'],
      chroma: 0.05, contrast: 1.2,
      texture: 'hammered', textureScale: 90, textureStrength: 0.22,
      edgeStrength: 0.34, edgeColor: '#000000',
      sheen: 0.16, sheenColor: '#c8ccd6',
    },
    objects: {
      tv: {
        ramp: ['#1a0602', '#7a1f05', '#d96a14', '#ffd489'],
        chroma: 0.18, contrast: 1.35,
        texture: 'grain', textureScale: 120, textureStrength: 0.2,
        edgeStrength: 0.45, edgeColor: '#2b0a02',
        sheen: 1.0, sheenColor: '#ffc060',
      },
      chair: {
        ramp: ['#160c04', '#5c3512', '#b8823a', '#f6dfae'],
        chroma: 0.12, contrast: 1.22,
        texture: 'brushed', textureScale: 120, textureStrength: 0.15,
        edgeStrength: 0.26, edgeColor: '#0d0702',
        sheen: 0.5, sheenColor: '#ffe9b8',
      },
      sofa: {
        // Oxblood leather: the one soft, warm thing in a room of cold metal.
        ramp: ['#160406', '#4a0f16', '#8a2530', '#d47a80'],
        chroma: 0.1, contrast: 1.15,
        texture: 'weave', textureScale: 200, textureStrength: 0.2,
        edgeStrength: 0.2, edgeColor: '#0c0203',
        sheen: 0.22, sheenColor: '#ffc9c0',
      },
      'dining table': {
        // Polished brass, so it reads as a different metal from the iron room
        // rather than as the same metal under a different light.
        ramp: ['#1a1200', '#5c4406', '#a8811a', '#f0d68a'],
        chroma: 0.08, contrast: 1.3,
        texture: 'brushed', textureScale: 140, textureStrength: 0.18,
        edgeStrength: 0.3, edgeColor: '#0d0900',
        sheen: 0.75, sheenColor: '#ffe9ae',
      },
    },
  },
];

/** Every theme, validated. Built once — themes are immutable in use. */
export const THEMES_ALL = THEMES.map(makeTheme);

export const THEME_IDS = THEMES_ALL.map((t) => t.id);

export function themeById(id) {
  return THEMES_ALL.find((t) => t.id === id) || null;
}

export default { THEMES_ALL, THEME_IDS, themeById };
