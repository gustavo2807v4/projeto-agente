import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // The PWA suite needs a production build + preview server, not the dev
  // server this config uses — it runs separately via `npm run test:pwa`.
  testIgnore: '**/pwa/**',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
