// End-to-end tests against a published Webflow test site.
// By default the site's Pageflow <script> is served from the local dist/ build,
// so the tests check the working copy. PAGEFLOW_CDN=1 tests the published release.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: require('./tests/helpers').SITE,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }]
});
