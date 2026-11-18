import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest DI는 emitDecoratorMetadata가 필요함
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
