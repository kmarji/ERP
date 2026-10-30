// Packs a canvas bitmap into one ESC/POS raster image (GS v 0) followed by feed and cut. Rendering the receipt as an
// image sidesteps printer code pages, so Arabic prints correctly on any ESC/POS printer.
export function rasterToEscPos(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(2 + 8 + bytesPerRow * height + 8);
  let o = 0;
  out.set([0x1b, 0x40], o); o += 2; // ESC @ initialise
  out.set([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 255, bytesPerRow >> 8, height & 255, height >> 8], o); o += 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = rgba[i + 3] > 127 && (rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11) < 140;
      if (dark) out[o + y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  o += bytesPerRow * height;
  out.set([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00, 0x00], o); // feed 4 lines, partial cut
  return out;
}
