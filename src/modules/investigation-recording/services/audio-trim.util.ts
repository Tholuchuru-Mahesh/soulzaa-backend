import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import type { RecordedSegment } from './room-recording-lifecycle.service';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Downloads the real recorded segments overlapping an evidence window,
 * concatenates them (they're consecutive chunks of the same continuous
 * ZEGO Cloud Recording task) and trims to exactly [windowStart, windowEnd].
 * Throws if no segment data could be downloaded — callers must treat that as
 * a real failure, not fall back to synthesizing audio.
 */
export async function downloadAndTrimSegments(
  segments: RecordedSegment[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Buffer> {
  if (segments.length === 0) {
    throw new Error('No recorded segments available for this window');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'evidence-trim-'));
  try {
    const inputPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const res = await fetch(segments[i].fileUrl);
      if (!res.ok) {
        throw new Error(
          `Failed to download recording segment (HTTP ${res.status}): ${segments[i].fileUrl}`,
        );
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const inputPath = join(workDir, `segment-${i}${extname(segments[i].fileUrl)}`);
      await writeFile(inputPath, bytes);
      inputPaths.push(inputPath);
    }

    const concatPath = join(workDir, `concat-${randomUUID()}.txt`);
    await writeFile(
      concatPath,
      inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );

    const firstSegmentStart = segments[0].startedAt.getTime();
    const offsetSeconds = Math.max(0, (windowStart.getTime() - firstSegmentStart) / 1000);
    const durationSeconds = Math.max(1, (windowEnd.getTime() - windowStart.getTime()) / 1000);

    const outputPath = join(workDir, 'evidence.m4a');
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-ss',
          String(offsetSeconds),
          '-t',
          String(durationSeconds),
          '-vn',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function extname(url: string): string {
  const clean = url.split('?')[0];
  const dot = clean.lastIndexOf('.');
  return dot === -1 ? '.aac' : clean.slice(dot);
}
