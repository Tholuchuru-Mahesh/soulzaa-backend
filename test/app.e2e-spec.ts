import { ValidationPipe } from '@nestjs/common';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Smoke test. Requires Postgres + Redis to be reachable (docker compose up -d
 * postgres redis). Verifies the app boots and the ops/auth wiring responds.
 */
describe('Soulzaa backend (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health → 200 (liveness)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    // Wrapped by the global success-envelope interceptor.
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /health/ready → 200 with postgres + redis up', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.info.database.status).toBe('up');
    expect(res.body.data.info.redis.status).toBe('up');
  });

  it('GET /metrics → prometheus exposition', async () => {
    const res = await request(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

  it('GET /api/ping → 200 (public)', async () => {
    const res = await request(app.getHttpServer()).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { pong: true, service: 'soulzaa-backend' },
      timestamp: expect.any(String),
    });
  });

  it('GET /api/me → 401 without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/me');
    expect(res.status).toBe(401);
  });
});
