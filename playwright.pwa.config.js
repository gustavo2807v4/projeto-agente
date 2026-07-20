import { defineConfig } from '@playwright/test';

// PWA features (manifest injection, service worker) only exist in the built
// output, not the dev server — so this suite runs against `vite preview`
// instead of `vite dev`. Run with: npm run test:pwa
export default defineConfig({
  testDir: './tests/pwa',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4174'
  },
  webServer: {
    command: 'npm run preview -- --port 4174',
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
