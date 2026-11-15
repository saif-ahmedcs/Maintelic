import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { CorrelatedLogger } from './common/logger/correlated-logger';
import { buildBackendMqttOptions } from './common/mqtt/mqtt-connection-options';
import { buildSwaggerDocument } from './common/swagger/swagger-document';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

const JSON_BODY_LIMIT = '100kb';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useLogger(new CorrelatedLogger());
  app.use(helmet());
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: JSON_BODY_LIMIT });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerDocument = buildSwaggerDocument(app);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.MQTT,
    options: buildBackendMqttOptions({
      host: process.env.MQTT_HOST as string,
      port: process.env.MQTT_PORT as string,
      password: process.env.MQTT_BACKEND_PASSWORD as string,
    }),
  });

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
