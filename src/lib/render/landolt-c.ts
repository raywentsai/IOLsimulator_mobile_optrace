import { MAX_FIELD_PX } from '../optics/acuity-calibration.ts';
import { gaussianHalfKernel } from './gl/gaussian.ts';

const SUBPIXELS = 4;

export function landoltInk(x: number, y: number, diameter: number, direction: number): boolean {
  const radiusSquared = x * x + y * y;
  const angle = direction * Math.PI / 4;
  return radiusSquared <= (diameter / 2) ** 2 && radiusSquared >= (diameter * 0.3) ** 2 &&
    !(x * Math.cos(angle) + y * Math.sin(angle) >= 0 &&
      Math.abs(-x * Math.sin(angle) + y * Math.cos(angle)) <= diameter / 10);
}

export function renderLandoltC(canvas: HTMLCanvasElement, size: number, diameterPx: number, sigmaPx: number, direction: number) {
  if (size > MAX_FIELD_PX) return false;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return false;
  canvas.width = canvas.height = size;
  const ink = new Float32Array(size * size);
  const origin = (size - diameterPx) / 2;
  for (let y = Math.floor(origin); y < size - origin; y++) {
    for (let x = Math.floor(origin); x < size - origin; x++) {
      let count = 0;
      for (let sy = 0; sy < SUBPIXELS; sy++) {
        for (let sx = 0; sx < SUBPIXELS; sx++) {
          const dx = x + (sx + 0.5) / SUBPIXELS - size / 2;
          const dy = y + (sy + 0.5) / SUBPIXELS - size / 2;
          if (landoltInk(dx, dy, diameterPx, direction)) count++;
        }
      }
      ink[y * size + x] = count / SUBPIXELS ** 2;
    }
  }

  const kernel = gaussianHalfKernel(sigmaPx);
  const horizontal = sigmaPx === 0 ? ink : blurAxis(ink, size, kernel, false);
  const blurred = sigmaPx === 0 ? ink : blurAxis(horizontal, size, kernel, true);
  const image = context.createImageData(size, size);
  for (let i = 0; i < blurred.length; i++) {
    // Match the current scene Gaussian, which filters display-encoded values.
    const byte = Math.round(255 * (1 - blurred[i]));
    image.data.fill(byte, 4 * i, 4 * i + 3);
    image.data[4 * i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return true;
}

function blurAxis(source: Float32Array, size: number, kernel: number[], vertical: boolean) {
  const blurred = new Float32Array(source.length);
  const stride = vertical ? size : 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const position = vertical ? y : x;
      const i = y * size + x;
      let sum = source[i] * kernel[0];
      for (let offset = 1; offset < kernel.length; offset++) {
        if (position >= offset) sum += source[i - offset * stride] * kernel[offset];
        if (position + offset < size) sum += source[i + offset * stride] * kernel[offset];
      }
      blurred[i] = sum;
    }
  }
  return blurred;
}
