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
  base: '/agent-workflows/',
  plugins: [react(), pagesSpaFallback()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
