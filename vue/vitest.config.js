import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/backend-*.test.cjs', 'test/frontend-*.test.js'],
    restoreMocks: true,
    clearMocks: true,
  },
})
