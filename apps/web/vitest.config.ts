import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The QR reader's WASM, loaded `?inline` by its test (src/app/qr.test.ts).
  assetsInclude: ['**/*.wasm'],
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
    environment: 'node',
  },
});
