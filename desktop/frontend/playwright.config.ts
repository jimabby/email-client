import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './test', timeout: 30000, use: { baseURL: 'http://127.0.0.1:5178', headless: true, channel: process.env.PW_CHANNEL },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: false },
})
