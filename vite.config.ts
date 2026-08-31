import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * GitHub Pages serves `404.html` for any path that does not match a file on disk, which is what
 * keeps real routes such as `/dependencies/owner/repo` working on a static project site.
 * https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site
 */
function pagesSpaFallback(): Plugin {
  return {
    name: 'pages-spa-fallback',
    apply: 'build',
    closeBundle() {
      const dist = new URL('./dist/', import.meta.url)
      copyFileSync(fileURLToPath(new URL('index.html', dist)), fileURLToPath(new URL('404.html', dist)))
    },
  }
}

export default defineConfig({
  // Project sites are served from /<repository>/, so every asset URL carries that prefix.
  base: '/issues-graph/',
  plugins: [react(), pagesSpaFallback()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * ELK lays out the captured backlogs for real, which is seconds of genuine work — the largest
     * single test measures ~2s on its own. Vitest runs the files in parallel workers, so that test
     * shares a machine with every other file and the 5s default leaves it no headroom: the suite
     * failed on timeouts, not assertions, as soon as one more file was added. The figure is
     * deliberately far above the real cost, because a timeout here is only ever meant to stop a
     * hang, never to measure how loaded the machine is.
     */
    testTimeout: 30000,
  },
})
