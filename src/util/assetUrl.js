/**
 * Resolve an app-relative asset path against the *page*, not against whichever
 * module happens to be asking.
 *
 * This is not pedantry. `fetch('./vendor/x')` resolves against the document,
 * but `import('./vendor/x')` resolves against the importing module's own URL —
 * so a probe made from `src/vision/` finds the file at `/vendor/x` and reports
 * "local copy available", and the dynamic import a line later asks for
 * `/src/vision/vendor/x` and 404s. Local mode then fails in the one way that
 * is hardest to read: the code says it found what it then cannot load.
 *
 * Resolving against `document.baseURI` rather than prefixing a `/` matters
 * because the app is served from a subpath on GitHub Pages (`/AR-Fight/`),
 * where a root-absolute path would point outside the deployment.
 */

/** Anything with a scheme (https:, blob:, data:) is already absolute. */
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export function assetUrl(pathOrUrl) {
  if (!pathOrUrl || ABSOLUTE.test(pathOrUrl)) return pathOrUrl;
  if (typeof document === 'undefined') return pathOrUrl; // Node: tests, parse checks
  return new URL(pathOrUrl, document.baseURI).href;
}

export default assetUrl;
