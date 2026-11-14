/**
 * Gaussian kernel generation and caching used by the WebGL blur passes.
 */

const MAX_UNIFORM_TAPS = 32;

// One half of a symmetric, normalized discrete Gaussian.
export function gaussianHalfKernel(sigma: number): number[] {
  if (sigma === 0) return [1];
  const radius = Math.ceil(4 * sigma);
  const weights = Array.from({ length: radius + 1 }, (_, i) => Math.exp(-0.5 * (i / sigma) ** 2));
  const sum = weights.reduce((total, weight, i) => total + weight * (i === 0 ? 1 : 2), 0);
  return weights.map(weight => weight / sum);
}

/**
 * Gaussian kernel data structure.
 */
interface GaussianKernel {
  weights: number[];
  offsets: number[];
  tapCount: number;
}

function generateLinearSamplingKernel(sigma: number): GaussianKernel {
  const fullWeights = gaussianHalfKernel(sigma);

  const weights: number[] = [fullWeights[0]];
  const offsets: number[] = [0];

  for (let i = 1; i < fullWeights.length; i += 2) {
    const w1 = fullWeights[i];
    const w2 = i + 1 < fullWeights.length ? fullWeights[i + 1] : 0;
    const combinedWeight = w1 + w2;

    if (combinedWeight > 0) {
      const offset = i + w2 / combinedWeight;
      weights.push(combinedWeight);
      offsets.push(offset);
    }
  }

  const tapCount = weights.length;
  while (weights.length < MAX_UNIFORM_TAPS) {
    weights.push(0);
    offsets.push(0);
  }

  return { weights, offsets, tapCount };
}

/**
 * Kernel cache for performance optimization.
 */
export class KernelCache {
  private cache = new Map<number, GaussianKernel>();
  private readonly SIGMA_STEPS_PER_TEXEL = 20;
  private readonly MAX_CACHE_SIZE = 50;

  getKernel(sigma: number): GaussianKernel {
    const key = Math.round(sigma * this.SIGMA_STEPS_PER_TEXEL);
    const cached = this.cache.get(key);
    const kernel = cached ?? generateLinearSamplingKernel(key / this.SIGMA_STEPS_PER_TEXEL);
    this.cache.delete(key);
    this.cache.set(key, kernel);
    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return kernel;
  }

  clear(): void {
    this.cache.clear();
  }
}
