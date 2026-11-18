import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { createFastifyAdapter, setupApp } from './app.setup.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createFastifyAdapter());
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  setupApp(app, { swagger: config.get('NODE_ENV', { infer: true }) !== 'production' });

  const host = config.get('HOST', { infer: true });
  const port = config.get('PORT', { infer: true });

  await app.listen(port, host);
  Logger.log(`서버 시작: http://localhost:${port}`, 'Bootstrap');
}

await bootstrap();
