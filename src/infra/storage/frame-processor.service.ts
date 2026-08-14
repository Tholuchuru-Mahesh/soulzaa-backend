import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

export interface ProcessedFrameResult {
  buffer: Buffer;
  mimeType: string;
  isProcessed: boolean;
}

@Injectable()
export class FrameProcessorService {
  private readonly logger = new Logger(FrameProcessorService.name);

  /**
   * Processes a profile frame asset (PNG, JPEG, WebP, SVG) to guarantee a transparent
   * background and open center for profile avatar display without destroying artwork.
   */
  async processFrame(buffer: Buffer, mimeType: string): Promise<ProcessedFrameResult> {
    if (!buffer || buffer.length === 0) {
      return { buffer, mimeType, isProcessed: false };
    }

    const normalizedMime = mimeType.toLowerCase();

    if (normalizedMime.includes('svg')) {
      return this.processSvg(buffer);
    }

    try {
      return await this.processRaster(buffer);
    } catch (err: any) {
      this.logger.error(
        `Failed to process frame image background: ${err?.message ?? err}`,
        err?.stack,
      );
      return { buffer, mimeType, isProcessed: false };
    }
  }

  /**
   * SVG processing: removes root/canvas solid background rects while preserving vector artwork.
   */
  private processSvg(buffer: Buffer): ProcessedFrameResult {
    let svgText = buffer.toString('utf-8');

    // Remove background rect elements that span full canvas or corners with solid fill
    svgText = svgText.replace(
      /<rect\b[^>]*\b(fill="(?:#000000|#ffffff|black|white|#[0-9a-fA-F]{6})")[^>]*\/>/gi,
      (match) => {
        if (
          match.includes('width="100%"') ||
          match.includes('width="100"') ||
          match.includes('id="background"') ||
          match.includes('id="bg"')
        ) {
          return '<!-- removed bg rect -->';
        }
        return match;
      },
    );

    return {
      buffer: Buffer.from(svgText, 'utf-8'),
      mimeType: 'image/svg+xml',
      isProcessed: true,
    };
  }

  /**
   * Raster image processing (PNG, JPEG, WebP):
   * Flood-fills background regions from outer corners and center opening to set alpha = 0.
   */
  private async processRaster(inputBuffer: Buffer): Promise<ProcessedFrameResult> {
    const { data, info } = await sharp(inputBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const channels = info.channels; // 4 (RGBA)

    if (channels !== 4) {
      return { buffer: inputBuffer, mimeType: 'image/png', isProcessed: false };
    }

    const visited = new Uint8Array(width * height);
    const pixelData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const getIdx = (x: number, y: number) => y * width + x;
    const getOffset = (x: number, y: number) => (y * width + x) * 4;

    // Seed locations: 4 outer corners + center opening
    const seeds: Array<[number, number]> = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
      [Math.floor(width / 2), Math.floor(height / 2)],
      [Math.floor(width / 4), Math.floor(height / 2)],
      [Math.floor((3 * width) / 4), Math.floor(height / 2)],
    ];

    const tolerance = 48.0; // Color distance threshold (0-255 scale)
    const featherZone = 16.0;

    for (const [sx, sy] of seeds) {
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      const seedIdx = getIdx(sx, sy);
      if (visited[seedIdx]) continue;

      const seedOff = getOffset(sx, sy);
      const sr = pixelData[seedOff];
      const sg = pixelData[seedOff + 1];
      const sb = pixelData[seedOff + 2];
      const sa = pixelData[seedOff + 3];

      // If seed is already transparent, flood-fill transparent region to ensure connected pixels are cleared
      const isTransparentSeed = sa < 15;

      const queue: number[] = [sx, sy];
      visited[seedIdx] = 1;

      let qHead = 0;
      while (qHead < queue.length) {
        const cx = queue[qHead++];
        const cy = queue[qHead++];

        const coff = getOffset(cx, cy);
        const cr = pixelData[coff];
        const cg = pixelData[coff + 1];
        const cb = pixelData[coff + 2];
        const ca = pixelData[coff + 3];

        let dist = 0;
        if (isTransparentSeed) {
          dist = ca; // Distance based on alpha
        } else {
          const dr = cr - sr;
          const dg = cg - sg;
          const db = cb - sb;
          dist = Math.sqrt(dr * dr + dg * dg + db * db);
        }

        if (isTransparentSeed || dist <= tolerance) {
          if (!isTransparentSeed) {
            if (dist <= tolerance - featherZone) {
              pixelData[coff + 3] = 0;
            } else {
              const alphaFactor = (dist - (tolerance - featherZone)) / featherZone;
              pixelData[coff + 3] = Math.min(ca, Math.round(255 * alphaFactor));
            }
          }

          // Explore 4-connected neighbors
          const neighbors: Array<[number, number]> = [
            [cx + 1, cy],
            [cx - 1, cy],
            [cx, cy + 1],
            [cx, cy - 1],
          ];

          for (const [nx, ny] of neighbors) {
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = getIdx(nx, ny);
              if (!visited[nidx]) {
                visited[nidx] = 1;
                queue.push(nx, ny);
              }
            }
          }
        }
      }
    }

    const outputBuffer = await sharp(Buffer.from(pixelData.buffer), {
      raw: { width, height, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return {
      buffer: outputBuffer,
      mimeType: 'image/png',
      isProcessed: true,
    };
  }
}
