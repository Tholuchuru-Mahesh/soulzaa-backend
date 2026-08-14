"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
describe('Soulzaa backend (e2e)', () => {
    let app;
    beforeAll(async () => {
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
        app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, transform: true }));
        await app.init();
    }, 30_000);
    afterAll(async () => {
        await app?.close();
    });
    it('GET /health → 200 (liveness)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('ok');
    });
    it('GET /health/ready → 200 with postgres + redis up', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/health/ready');
        expect(res.status).toBe(200);
        expect(res.body.data.info.database.status).toBe('up');
        expect(res.body.data.info.redis.status).toBe('up');
    });
    it('GET /metrics → prometheus exposition', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/metrics');
        expect(res.status).toBe(200);
        expect(res.text).toContain('http_requests_total');
    });
    it('GET /api/ping → 200 (public)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/ping');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: { pong: true, service: 'soulzaa-backend' },
            timestamp: expect.any(String),
        });
    });
    it('GET /api/me → 401 without a token', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/me');
        expect(res.status).toBe(401);
    });
});
//# sourceMappingURL=app.e2e-spec.js.map