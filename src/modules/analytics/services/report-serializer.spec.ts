import { serializeReport, SUPPORTED_EXPORT_FORMATS } from './report-serializer';

describe('serializeReport', () => {
  const report = {
    name: 'Revenue July',
    domain: 'REVENUE',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    data: { total_revenue_coins: 5000, host_earnings_coins: 3500 },
  };

  describe('CSV', () => {
    it('emits a metric/value header and one row per metric', () => {
      const { body } = serializeReport(report, 'CSV');
      expect(body.toString()).toBe(
        'metric,value\ntotal_revenue_coins,5000\nhost_earnings_coins,3500\n',
      );
    });

    it('quotes values containing a comma so columns cannot shift', () => {
      const { body } = serializeReport({ ...report, data: { note: 'a,b' } }, 'CSV');
      expect(body.toString()).toBe('metric,value\nnote,"a,b"\n');
    });

    it('escapes embedded quotes by doubling them', () => {
      const { body } = serializeReport({ ...report, data: { note: 'say "hi"' } }, 'CSV');
      expect(body.toString()).toBe('metric,value\nnote,"say ""hi"""\n');
    });

    it('quotes values containing a newline', () => {
      const { body } = serializeReport({ ...report, data: { note: 'a\nb' } }, 'CSV');
      expect(body.toString()).toBe('metric,value\nnote,"a\nb"\n');
    });

    it('reports a text/csv content type and a .csv extension', () => {
      const { contentType, extension } = serializeReport(report, 'CSV');
      expect(contentType).toBe('text/csv');
      expect(extension).toBe('csv');
    });

    it('still produces a header when the report has no data', () => {
      const { body } = serializeReport({ ...report, data: null }, 'CSV');
      expect(body.toString()).toBe('metric,value\n');
    });
  });

  describe('JSON', () => {
    it('serializes the whole report', () => {
      const { body, contentType, extension } = serializeReport(report, 'JSON');
      expect(JSON.parse(body.toString())).toMatchObject({
        name: 'Revenue July',
        domain: 'REVENUE',
        data: { total_revenue_coins: 5000 },
      });
      expect(contentType).toBe('application/json');
      expect(extension).toBe('json');
    });
  });

  it('rejects a format it cannot actually produce', () => {
    expect(() => serializeReport(report, 'PDF')).toThrow(/not supported/i);
  });

  it('advertises only the formats it can genuinely produce', () => {
    expect(SUPPORTED_EXPORT_FORMATS).toEqual(['CSV', 'JSON']);
  });
});
