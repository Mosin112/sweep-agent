import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { SWEEP_STATE_DIR: '.test-state', ANTHROPIC_API_KEY: '', DASHBOARD_URL: '' },
    fileParallelism: false,
  },
});
