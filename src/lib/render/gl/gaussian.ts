/**
 * Gaussian kernel generation and caching used by the WebGL blur passes.
 */

const MAX_UNIFORM_TAPS = 32;

// One half of a symmetric, normalized discrete Gaussian.
export function gaussianHalfKernel(sigma: number, radius = Math.ceil(4 * sigma)): number[] {
  if (sigma === 0) return [1];
  const weights = Array.from({ length: radius + 1 }, (_, i) => Math.exp(-0.5 * (i / sigma) ** 2));
  const sum = weights.reduce((total, weight, i) => total + weight * (i === 0 ? 1 : 2), 0);
  return weights.map(weight => weight / sum);
}

/**
 * Gaussian kernel data structure.
 */
export interface GaussianKernel {
  weights: number[];
  offsets: number[];
  tapCount: number;
  sigma: number;
}

function generateLinearSamplingKernel(sigma: number, maxPairs: number = 30): GaussianKernel {
  const clampedSigma = Math.min(30, sigma);
  // clamp large sigmas for performance
  const radius = Math.min(Math.ceil(4 * clampedSigma), maxPairs * 2);
  // radius = 4 to match SciPy’s default from the original Leung's work
  const fullWeights = gaussianHalfKernel(clampedSigma, radius);

  const weights: number[] = [fullWeights[0]];
  const offsets: number[] = [0];

  for (let i = 1; i < fullWeights.length; i += 2) {
    const w1 = fullWeights[i];
    const w2 = i + 1 < fullWeights.length ? fullWeights[i + 1] : 0;
    const combinedWeight = w1 + w2;

    if (combinedWeight > 0) {
      const offset = (i * w1 + (i + 1) * w2) / combinedWeight;
      weights.push(combinedWeight);
      offsets.push(offset);
    }
  }

  const tapCount = weights.length;
  while (weights.length < MAX_UNIFORM_TAPS) {
    weights.push(0);
    offsets.push(0);
  }

  return {
    weights: weights.slice(0, MAX_UNIFORM_TAPS),
    offsets: offsets.slice(0, MAX_UNIFORM_TAPS),
    tapCount,
    sigma: clampedSigma
  };
}

/**
 * Kernel cache for performance optimization.
 */
export class KernelCache {
  private cache = new Map<string, GaussianKernel>();
  private accessTimes = new Map<string, number>();
  private readonly SIGMA_QUANTIZATION = 0.05;
  private readonly MAX_CACHE_SIZE = 50;

  getKernel(sigma: number): GaussianKernel {
    const quantizedSigma = Math.round(sigma / this.SIGMA_QUANTIZATION) * this.SIGMA_QUANTIZATION;
    const key = quantizedSigma.toFixed(2);

    const cachedKernel = this.cache.get(key);
    if (cachedKernel) {
      this.accessTimes.set(key, Date.now());
      return cachedKernel;
    }

    this.enforceMemoryLimits();
    const kernel = generateLinearSamplingKernel(quantizedSigma);
    this.cache.set(key, kernel);
    this.accessTimes.set(key, Date.now());
    return kernel;
  }

  private enforceMemoryLimits(): void {
    if (this.cache.size < this.MAX_CACHE_SIZE) {
      return;
    }

    const oldestKey = this.findLeastRecentlyUsed();
    if (!oldestKey) {
      return;
    }

    this.cache.delete(oldestKey);
    this.accessTimes.delete(oldestKey);
  }

  private findLeastRecentlyUsed(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, time] of this.accessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  clear(): void {
    this.cache.clear();
    this.accessTimes.clear();
  }
}
