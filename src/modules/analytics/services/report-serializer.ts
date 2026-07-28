/**
 * Turns a stored analytics report into a downloadable file.
 *
 * Only formats that can genuinely be produced are advertised. EXCEL and PDF are
 * deliberately absent: accepting them and emitting a CSV (or an empty file) named
 * `.pdf` gives the caller a broken download and a green status, which is worse
 * than an honest rejection. Adding them means adding a real renderer.
 */
export const SUPPORTED_EXPORT_FORMATS = ['CSV', 'JSON'] as const;

export type ExportFormat = (typeof SUPPORTED_EXPORT_FORMATS)[number];

export interface SerializableReport {
  name: string;
  domain: string;
  createdAt: Date;
  data: unknown;
}

export interface SerializedReport {
  body: Buffer;
  contentType: string;
  extension: string;
}

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function serializeReport(report: SerializableReport, format: string): SerializedReport {
  const normalized = format.toUpperCase();

  if (normalized === 'CSV') {
    const metrics =
      report.data && typeof report.data === 'object'
        ? (report.data as Record<string, unknown>)
        : {};
    const rows = Object.entries(metrics).map(
      ([metric, value]) => `${csvCell(metric)},${csvCell(value)}`,
    );
    return {
      body: Buffer.from(['metric,value', ...rows].join('\n') + '\n', 'utf8'),
      contentType: 'text/csv',
      extension: 'csv',
    };
  }

  if (normalized === 'JSON') {
    return {
      body: Buffer.from(JSON.stringify(report, null, 2), 'utf8'),
      contentType: 'application/json',
      extension: 'json',
    };
  }

  throw new Error(
    `Export format '${format}' is not supported. Supported formats: ${SUPPORTED_EXPORT_FORMATS.join(', ')}`,
  );
}
