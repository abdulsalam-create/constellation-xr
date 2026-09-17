import { defineConfig } from 'vite';

/**
 * `base` is what makes the build work when served from a repository subpath on
 * GitHub Pages (`/constellation-xr/`) as well as from a domain root. The deploy
 * workflow sets BASE_PATH; local `vite dev` falls through to '/'.
 *
 * `process.env` is read through a narrow cast rather than @types/node: the app
 * itself must not depend on Node types, and pulling them in for one config file
 * would let a Node-only global slip into browser code unnoticed.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export default defineConfig({
  base: env?.['BASE_PATH'] ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js is ~600KB; splitting it out lets the browser cache it across
        // deploys instead of re-downloading it whenever application code changes.
        manualChunks: (id: string): string | undefined =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
  worker: {
    format: 'es',
  },
});
