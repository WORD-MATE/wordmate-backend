import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const host = config.get('HOST', { infer: true });
  const port = config.get('PORT', { infer: true });

  await app.listen(port, host);
  Logger.log(`서버 시작: http://localhost:${port}`, 'Bootstrap');
}

await bootstrap();
