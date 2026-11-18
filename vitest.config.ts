import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest DI는 emitDecoratorMetadata가 필요함
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          hookTimeout: 120_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
