import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module';

const JSON_BODY_LIMIT = '100kb';

describe('JSON body size limit (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a JSON body over 100KB with 413', async () => {
    const oversized = { padding: 'x'.repeat(101 * 1024) };
    await request(app.getHttpServer())
      .post('/auth/login')
      .send(oversized)
      .expect(413);
  });

  it('does not reject a JSON body under 100KB for being too large', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever-12345' });

    expect(res.status).not.toBe(413);
  });
});
