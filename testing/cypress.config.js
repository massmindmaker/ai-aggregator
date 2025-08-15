const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:3000',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    videosFolder: 'cypress/videos',
    screenshotsFolder: 'cypress/screenshots',
    video: true,
    screenshot: true,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
    viewportWidth: 1280,
    viewportHeight: 720,
    env: {
      STAGING_URL: 'https://aiag-staging.vercel.app',
      PRODUCTION_URL: 'https://aiag.vercel.app',
      API_URL: process.env.CYPRESS_API_URL || 'http://localhost:5000',
      TEST_USER_EMAIL: 'test@aiag.com',
      TEST_USER_PASSWORD: 'testpassword123'
    }
  },
  component: {
    devServer: {
      framework: 'react',
      bundler: 'webpack',
    },
  },
});