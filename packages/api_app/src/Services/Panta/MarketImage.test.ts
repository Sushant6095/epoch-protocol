import { inflateSync } from 'zlib';

import { drawMarketImage, encodePng, MARKET_IMAGE_SIZE, marketImage } from './MarketImage';

/** The PNG's chunks: [type, data]. */
function chunks(png: Buffer): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    out.push([png.toString('ascii', at + 4, at + 8), png.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return out;
}

describe('MarketImage', () => {
  it('is a 1024×1024 8-bit RGB PNG that decodes back to the drawing', () => {
    const { png, etag } = marketImage();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = chunks(png);
    expect(parts.map(([type]) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = parts[0][1];
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([1_024, 1_024, 8, 2]);
    const raw = inflateSync(parts[1][1]);
    expect(raw.length).toBe((MARKET_IMAGE_SIZE * 3 + 1) * MARKET_IMAGE_SIZE);
    const pixels = drawMarketImage().pixels;
    expect(Buffer.from(raw.subarray(1, 1 + MARKET_IMAGE_SIZE * 3)).equals(Buffer.from(pixels.subarray(0, 3_072)))).toBe(
      true,
    );
    expect(png.length).toBeLessThan(100_000);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(marketImage().png).toBe(png); // drawn once
  });

  it('writes valid chunk checksums', () => {
    // A 1×1 white PNG has a well-known IHDR CRC (0x907753de for 1×1, 8-bit RGB).
    const png = encodePng(1, 1, new Uint8Array([255, 255, 255]));
    expect(png.readUInt32BE(8 + 4 + 4 + 13)).toBe(0x907753de);
    expect(chunks(png).at(-1)?.[0]).toBe('IEND');
  });
});
