/**
 * Registers the `three` resolve hook, then hands control back to Node.
 *
 * Used as `node --import ./tools/three-loader.js <script>`; a separate file is
 * required because `module.register` must run before the target module graph
 * is resolved.
 */
import { register } from 'node:module';

register('./three-resolver.js', import.meta.url);
