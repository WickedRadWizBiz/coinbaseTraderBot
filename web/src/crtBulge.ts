// Displacement map for the #crt-bulge SVG filter (web/index.html): a gentle barrel distortion, so the
// contents of every screen look very slightly convex, like the face of an old tube.
//
// feDisplacementMap samples the source at P + scale * (C - 0.5) for map channel C. With x, y in [-1, 1]
// from the centre and r² = x² + y², each output pixel samples r² * BULGE further out: the picture is
// squeezed toward the edges and bows outward, most at the corners (about 1% of the width there).

/** Barrel strength (normalised units); about a third of a typical CRT curvature. */
const BULGE = 0.012;
/** Must match the filter's scale attribute: the largest offset the map can encode (fraction of the box). */
const SCALE = 0.05;
const SIZE = 256;

export function installCrtBulge(): void {
  const el = document.getElementById('crt-bulge-map');
  if (!el) return;
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      const x = ((i + 0.5) / SIZE) * 2 - 1, y = ((j + 0.5) / SIZE) * 2 - 1;
      const r2 = x * x + y * y;
      // Offset as a fraction of the box (half the normalised offset), encoded around 0.5.
      const dx = (x * BULGE * r2) / 2, dy = (y * BULGE * r2) / 2;
      const k = (j * SIZE + i) * 4;
      img.data[k] = Math.round(Math.max(0, Math.min(1, 0.5 + dx / SCALE)) * 255);
      img.data[k + 1] = Math.round(Math.max(0, Math.min(1, 0.5 + dy / SCALE)) * 255);
      img.data[k + 2] = 128;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  el.setAttribute('href', url);
  el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
}
