import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // Exposed via reverse proxy; every route can trigger scraping with our Traderie account
  const token = process.env.API_TOKEN;
  if (token) {
    app.use((req, res, next) =>
      req.headers['x-api-token'] === token ? next() : res.status(401).json({ message: 'invalid api token' }));
  }
  await app.listen(process.env.PORT ?? 7432);
}
bootstrap();
