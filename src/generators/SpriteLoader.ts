/**
 * SpriteLoader — loads PNG images and extracts raw RGBA pixel data
 * as a Uint32Array for direct stamping into the pixel buffer.
 */

export interface LoadedSprite {
  w: number;
  h: number;
  /** ABGR pixel data matching the engine's packABGR format */
  pixels: Uint32Array;
}

/**
 * Load a PNG from a URL and return its pixel data as ABGR Uint32Array.
 */
export function loadSprite(url: string): Promise<LoadedSprite> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      const rgba = imageData.data;

      // Convert RGBA → ABGR Uint32Array (engine format)
      const pixels = new Uint32Array(img.width * img.height);
      for (let i = 0; i < pixels.length; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        const a = rgba[i * 4 + 3];
        pixels[i] = (a << 24) | (b << 16) | (g << 8) | r;
      }

      resolve({ w: img.width, h: img.height, pixels });
    };
    img.onerror = () => reject(new Error(`Failed to load sprite: ${url}`));
    img.src = url;
  });
}
