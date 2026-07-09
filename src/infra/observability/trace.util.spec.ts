import { currentTraceId, withSpan } from './trace.util';

describe('trace.util', () => {
  describe('withSpan', () => {
    it('runs the function and returns its result', async () => {
      const result = await withSpan('test.op', async () => 42);
      expect(result).toBe(42);
    });

    it('passes a span to the callback', async () => {
      const seen = await withSpan('test.op', async (span) => typeof span.setAttribute);
      expect(seen).toBe('function');
    });

    it('propagates thrown errors', async () => {
      await expect(
        withSpan('test.op', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('accepts attributes without throwing', async () => {
      await expect(withSpan('test.op', async () => 'ok', { 'app.gift.id': 'g1' })).resolves.toBe(
        'ok',
      );
    });
  });

  describe('currentTraceId', () => {
    it('returns undefined when no real trace is active (tracing disabled)', () => {
      expect(currentTraceId()).toBeUndefined();
    });
  });
});
