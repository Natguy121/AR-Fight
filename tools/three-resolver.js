/**
 * ESM resolve hook mapping the bare specifier `three` to the vendored build.
 *
 * In the browser the import map in `index.html` does this. Node has no import
 * map, and the app has no `node_modules`, so the test runner needs the same
 * redirect — otherwise every `import * as THREE from 'three'` in `src/` fails.
 *
 * Registered by `tools/three-loader.js`; see the `test` script.
 */

const VENDORED = new URL('../vendor/three/three.module.js', import.meta.url).href;

export function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: VENDORED, format: 'module', shortCircuit: true };
  }
  return next(specifier, context);
}
