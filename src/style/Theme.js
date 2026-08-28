import { makeStyle, lerpStyle, passthroughStyle } from './Style.js';

/**
 * A whole world, rather than a single material.
 *
 * Repainting everything uniformly can only ever look like a colour filter,
 * because it has no idea what anything *is*. A theme is the fix: a base
 * material for the room, plus a specific treatment for each kind of object the
 * segmenter can actually recognise. That is what lets a TV become a whiteboard
 * while the sofa becomes something else entirely and the walls become a third
 * thing — one coherent place instead of a tint.
 *
 * The class list is the model's own (`SceneSegmenter` reads it back with
 * `getLabels()` and warns if it ever disagrees with this). It is Pascal VOC,
 * which is a small and slightly odd vocabulary — but it happens to contain
 * exactly the furniture that fills a room: chair, sofa, tv, dining table,
 * potted plant, person.
 */

/** DeepLab-v3's classes, in model order. Index is what the mask stores. */
export const CLASSES = [
  'background', 'aeroplane', 'bicycle', 'bird', 'boat', 'bottle', 'bus', 'car',
  'cat', 'chair', 'cow', 'dining table', 'dog', 'horse', 'motorbike', 'person',
  'potted plant', 'sheep', 'sofa', 'train', 'tv',
];

export const CLASS_COUNT = CLASSES.length;

/** The classes actually worth authoring for: the ones found indoors. */
export const FURNITURE = ['chair', 'sofa', 'tv', 'dining table', 'potted plant', 'bottle', 'person'];

export function classIndex(name) {
  return CLASSES.indexOf(name);
}

/**
 * Validate a theme. Like `makeStyle`, this never throws — a theme is
 * something a model will be authoring, and a partly-usable one should render
 * partly right rather than fail.
 *
 * Unlisted classes deliberately fall through to `base` rather than getting a
 * placeholder: a cow appearing in a living room is a misdetection, and the
 * quietest thing it can do is look like the wall behind it.
 */
export function makeTheme(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = makeStyle(src.base || src);

  const objects = {};
  const srcObjects = src.objects && typeof src.objects === 'object' ? src.objects : {};
  for (const [name, style] of Object.entries(srcObjects)) {
    const key = String(name).toLowerCase();
    if (!CLASSES.includes(key)) continue; // silently drop names the model cannot detect
    objects[key] = makeStyle({ ...style, id: `${base.id}:${key}` });
  }

  return {
    id: typeof src.id === 'string' && src.id ? src.id : base.id,
    name: typeof src.name === 'string' && src.name ? src.name : base.name,
    blurb: typeof src.blurb === 'string' ? src.blurb : base.blurb,
    base,
    objects,
  };
}

/** The style a given class should render with: its own, or the room's. */
export function styleForClass(theme, className) {
  return theme.objects[className] || theme.base;
}

/** Per-class styles in model order, for building the shader lookup tables. */
export function themeStyleTable(theme) {
  return CLASSES.map((name) => styleForClass(theme, name));
}

/**
 * Blend two themes for the cross-fade.
 *
 * Classes present in only one side are blended against the *other* theme's
 * base, so a TV that is a whiteboard in one theme and unstyled in the other
 * fades to that other theme's wall material rather than snapping.
 */
export function lerpTheme(a, b, t) {
  const objects = {};
  for (const name of new Set([...Object.keys(a.objects), ...Object.keys(b.objects)])) {
    objects[name] = lerpStyle(styleForClass(a, name), styleForClass(b, name), t);
  }
  return {
    id: t < 0.5 ? a.id : b.id,
    name: t < 0.5 ? a.name : b.name,
    blurb: t < 0.5 ? a.blurb : b.blurb,
    base: lerpStyle(a.base, b.base, t),
    objects,
  };
}

/** The identity theme: the camera, untouched, with no object treatments. */
export function passthroughTheme() {
  const base = passthroughStyle();
  return { id: base.id, name: base.name, blurb: base.blurb, base, objects: {} };
}

export default { CLASSES, makeTheme, lerpTheme, passthroughTheme, styleForClass, themeStyleTable };
