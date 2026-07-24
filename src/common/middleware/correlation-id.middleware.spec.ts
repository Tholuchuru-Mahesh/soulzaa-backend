import { CorrelationIdMiddleware, CORRELATION_ID_HEADER } from './correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;

  beforeEach(() => {
    middleware = new CorrelationIdMiddleware();
  });

  it('should generate correlation ID if missing', () => {
    const req: any = { headers: {} };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBeDefined();
    expect(res.setHeader).toHaveBeenCalledWith(
      CORRELATION_ID_HEADER,
      req.headers[CORRELATION_ID_HEADER],
    );
    expect(next).toHaveBeenCalled();
  });

  it('should reuse existing correlation ID', () => {
    const req: any = { headers: { [CORRELATION_ID_HEADER]: 'existing-id-123' } };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBe('existing-id-123');
    expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'existing-id-123');
    expect(next).toHaveBeenCalled();
  });
});
