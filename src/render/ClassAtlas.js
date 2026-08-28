import * as THREE from 'three';
import { TEXTURES } from '../style/Style.js';
import { CLASS_COUNT, themeStyleTable } from '../style/Theme.js';

/**
 * Packs a whole theme — every class's material — into two small textures the
 * shader can look up per pixel.
 *
 * The obvious alternative, a uniform array per parameter indexed by class,
 * does not survive contact with real phones: twenty-one classes with a
 * four-stop ramp each is over a hundred vec4 uniform slots, and a device that
 * runs out does not warn, it fails to link the shader and shows a black
 * screen. Textures have no such limit.
 *
 * It is also faster. The ramp atlas stores each class's ramp as a *row*, so
 * the whole "map luminance through this material's gradient" operation
 * becomes one texture fetch with the GPU's own bilinear filter doing the
 * interpolation for free.
 */

/** Samples across each ramp row. 64 is far finer than 8-bit colour can show. */
export const RAMP_WIDTH = 64;
/** RGBA texels of packed scalars per class. See `_packParams`. */
export const PARAM_TEXELS = 4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toByte = (v) => Math.round(clamp01(v) * 255);

/** Evaluate a style's four-stop ramp at `t`, matching the shader's own lookup. */
function rampAt(style, t) {
  const x = clamp01(t) * (style.ramp.length - 1);
  const i = Math.min(style.ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = style.ramp[i];
  const b = style.ramp[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export class ClassAtlas {
  constructor() {
    this._rampData = new Uint8Array(RAMP_WIDTH * CLASS_COUNT * 4);
    this.rampTexture = new THREE.DataTexture(
      this._rampData, RAMP_WIDTH, CLASS_COUNT, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    // Linear so the ramp interpolates smoothly along X. Bleed along Y (into a
    // neighbouring class's ramp) is avoided by sampling exactly at row
    // centres, which makes the neighbour's filter weight zero — that is also
    // why the shader is compiled at highp: at mediump the row coordinate is
    // imprecise enough to pull in a few percent of the wrong material.
    this.rampTexture.minFilter = THREE.LinearFilter;
    this.rampTexture.magFilter = THREE.LinearFilter;
    this.rampTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.rampTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.rampTexture.generateMipmaps = false;

    this._paramData = new Uint8Array(PARAM_TEXELS * CLASS_COUNT * 4);
    this.paramTexture = new THREE.DataTexture(
      this._paramData, PARAM_TEXELS, CLASS_COUNT, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    // Nearest: these are exact values, not a gradient. Interpolating a
    // texture-type enum between two classes would select a third pattern.
    this.paramTexture.minFilter = THREE.NearestFilter;
    this.paramTexture.magFilter = THREE.NearestFilter;
    this.paramTexture.generateMipmaps = false;
  }

  /** Rebuild both textures from a theme. Cheap enough to call every frame of a fade. */
  update(theme) {
    const styles = themeStyleTable(theme);
    for (let c = 0; c < CLASS_COUNT; c++) {
      this._packRamp(styles[c], c);
      this._packParams(styles[c], c);
    }
    this.rampTexture.needsUpdate = true;
    this.paramTexture.needsUpdate = true;
    return this;
  }

  _packRamp(style, classIdx) {
    const row = classIdx * RAMP_WIDTH * 4;
    for (let x = 0; x < RAMP_WIDTH; x++) {
      const rgb = rampAt(style, x / (RAMP_WIDTH - 1));
      const o = row + x * 4;
      this._rampData[o] = toByte(rgb[0]);
      this._rampData[o + 1] = toByte(rgb[1]);
      this._rampData[o + 2] = toByte(rgb[2]);
      this._rampData[o + 3] = 255;
    }
  }

  /**
   * Four RGBA texels per class. Ranges are normalised on the way in and undone
   * in the shader; 8 bits is ~0.4% precision, far below what any of these
   * parameters can visibly resolve.
   *
   *   0: chroma, contrast/3, textureStrength, edgeStrength
   *   1: textureType (raw index), textureScale/400, sheen/1.5, —
   *   2: edgeColor rgb
   *   3: sheenColor rgb
   */
  _packParams(style, classIdx) {
    const o = classIdx * PARAM_TEXELS * 4;
    const d = this._paramData;

    d[o] = toByte(style.chroma);
    d[o + 1] = toByte(style.contrast / 3);
    d[o + 2] = toByte(style.textureStrength);
    d[o + 3] = toByte(style.edgeStrength);

    // Stored as a raw byte, not normalised: the shader multiplies by 255 to
    // recover the exact integer, so the enum survives the round trip.
    d[o + 4] = TEXTURES[style.texture] ?? 0;
    d[o + 5] = toByte(style.textureScale / 400);
    d[o + 6] = toByte(style.sheen / 1.5);
    d[o + 7] = 255;

    d[o + 8] = toByte(style.edgeColor[0]);
    d[o + 9] = toByte(style.edgeColor[1]);
    d[o + 10] = toByte(style.edgeColor[2]);
    d[o + 11] = 255;

    d[o + 12] = toByte(style.sheenColor[0]);
    d[o + 13] = toByte(style.sheenColor[1]);
    d[o + 14] = toByte(style.sheenColor[2]);
    d[o + 15] = 255;
  }

  dispose() {
    this.rampTexture.dispose();
    this.paramTexture.dispose();
  }
}

export default ClassAtlas;
