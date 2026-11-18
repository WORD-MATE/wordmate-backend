import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { collectedComponents } from './zod/openapi-schema.js';

export const SWAGGER_UI_PATH = 'swagger-ui';
export const OPENAPI_JSON_PATH = '/v3/api-docs';

export function setupSwagger(app: NestFastifyApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WordMate API')
    .setVersion('0.0.1')
    .setOpenAPIVersion('3.1.0')
    .addBearerAuth()
    .addCookieAuth('__Host-at')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...collectedComponents() },
  };

  SwaggerModule.setup(SWAGGER_UI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    swaggerOptions: { persistAuthorization: true },
  });
}
