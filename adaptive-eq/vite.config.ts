import { defineConfig } from 'vite';

export default defineConfig({
  // Discover the worker's dependency up front so a first analysis doesn't cause
  // Vite to optimize it late and reload away the user's selected track.
  optimizeDeps: { include: ['meyda'] },
});
