import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import helmet from 'helmet';
import { AppModule } from './../src/app.module';
import { buildSwaggerDocument } from './../src/common/swagger/swagger-document';

describe('Security headers (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(helmet());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    SwaggerModule.setup('api/docs', app, buildSwaggerDocument(app));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends Helmet default security headers on an API response', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-xss-protection']).toBe('0');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('still serves the Swagger UI page with Helmet enabled', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
