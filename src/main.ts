import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { createFastifyAdapter, setupApp } from './app.setup.js';
import { loadEnvFiles, validateEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  loadEnvFiles();
  const env = validateEnv(process.env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createFastifyAdapter(env),
    { bufferLogs: true },
  );
  app.enableShutdownHooks();
  await setupApp(app, {
    swagger: env.NODE_ENV !== 'production',
    corsOrigins: env.CORS_ORIGINS,
  });

  await app.listen(env.PORT, env.HOST);
  Logger.log(`서버 시작: http://localhost:${env.PORT}`, 'Bootstrap');
}

await bootstrap();
