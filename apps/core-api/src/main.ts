import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { PUBLIC_ASSETS_DIR } from './public-assets.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(PUBLIC_ASSETS_DIR);
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()) ?? false });
  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();
