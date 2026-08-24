import * as THREE from 'three';
import config from '../config.js';

/**
 * Lighting and spatial reference for the passthrough scene.
 *
 * Camera passthrough gives no depth cues of its own, so drawn geometry can
 * look pasted on. Directional light plus a warm/cool hemisphere gives strokes
 * real shading, and a faint floor grid gives the eye something to anchor scale
 * and distance against without obscuring the room behind it.
 */
export class Environment {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'environment';

    // Broad fill so nothing is ever fully black.
    this.hemisphere = new THREE.HemisphereLight(0xbfd8ff, 0x2a2622, 1.15);
    this.group.add(this.hemisphere);

    // Key light, slightly above and to one side, for readable form.
    this.key = new THREE.DirectionalLight(0xffffff, 1.35);
    this.key.position.set(1.2, 2.4, 1.0);
    this.group.add(this.key);

    // Cool rim from behind, so strokes separate from a busy background.
    this.rim = new THREE.DirectionalLight(0x8fc6ff, 0.55);
    this.rim.position.set(-1.4, 0.6, -1.6);
    this.group.add(this.rim);

    this.grid = new THREE.GridHelper(10, 20, 0x3d5a80, 0x22334a);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.2;
    this.grid.material.depthWrite = false;
    // Roughly floor height for someone standing, given the head sits at y = 0.
    this.grid.position.y = -1.5;
    this.grid.visible = config.debug.showGrid;
    this.group.add(this.grid);
  }

  setGridVisible(v) {
    this.grid.visible = v;
  }

  /** Move the reference floor, e.g. if the player is sitting. */
  setFloorHeight(y) {
    this.grid.position.y = y;
  }

  dispose() {
    this.grid.geometry.dispose();
    this.grid.material.dispose();
  }
}

export default Environment;
