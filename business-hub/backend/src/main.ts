import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'] });

  const swagger = new DocumentBuilder().setTitle('Business Hub API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
