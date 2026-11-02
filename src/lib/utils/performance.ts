/**
 * Performance optimization utilities used by the simulator render path.
 */

const TARGET_FRAME_TIME_MS = 20;
const BASE_MAX_TEXTURE_SIZE = 2048;
const MEMORY_LIMIT_BYTES = 100 * 1024 * 1024;
const INITIAL_QUALITY_LEVEL = 0.8;
const MIN_QUALITY_LEVEL = 0.3;
const MAX_QUALITY_LEVEL = 1.0;
const QUALITY_REDUCTION_STEP = 0.15;
const QUALITY_INCREASE_STEP = 0.03;
const MAX_BLUR_RADIUS = 8;

/**
 * Adaptive quality manager using device-agnostic limits.
 */
export class AdaptiveQuality {
  private frameTimes: number[] = [];
  private readonly maxSamples = 30;
  private qualityLevel = INITIAL_QUALITY_LEVEL;
  private memoryPressure = 0;

  recordFrameTime(frameTime: number): void {
    this.frameTimes.push(frameTime);
    if (this.frameTimes.length > this.maxSamples) {
      this.frameTimes.shift();
    }

    this.adjustQuality();
  }

  recordMemoryPressure(memoryUsage: number): void {
    this.memoryPressure = memoryUsage / MEMORY_LIMIT_BYTES;
  }

  private adjustQuality(): void {
    if (this.frameTimes.length < 10) {
      return;
    }

    const avgFrameTime = this.frameTimes.reduce((sum, time) => sum + time, 0) / this.frameTimes.length;
    const performanceRatio = avgFrameTime / TARGET_FRAME_TIME_MS;

    const memoryFactor = Math.max(1, this.memoryPressure * 2);
    const adjustedPerformanceRatio = performanceRatio * memoryFactor;

    if (adjustedPerformanceRatio > 1.5) {
      this.qualityLevel = Math.max(MIN_QUALITY_LEVEL, this.qualityLevel - QUALITY_REDUCTION_STEP);
    } else if (adjustedPerformanceRatio < 0.8 && this.memoryPressure < 0.7) {
      this.qualityLevel = Math.min(MAX_QUALITY_LEVEL, this.qualityLevel + QUALITY_INCREASE_STEP);
    }
  }

  getBlurQuality(): 'low' | 'medium' | 'high' | 'ultra' {
    if (this.qualityLevel < 0.4) return 'low';
    if (this.qualityLevel < 0.7) return 'medium';
    if (this.qualityLevel < 0.9) return 'high';
    return 'ultra';
  }

  getMaxTextureSize(): number {
    return Math.floor(BASE_MAX_TEXTURE_SIZE * this.qualityLevel);
  }

  getMaxBlurRadius(): number {
    return MAX_BLUR_RADIUS;
  }

  getKernelTaps(): number {
    const quality = this.getBlurQuality();
    switch (quality) {
      case 'low':
        return 8;
      case 'medium':
        return 12;
      case 'high':
        return 16;
      case 'ultra':
        return 20;
    }
  }

  getTargetFPS(): number {
    return Math.round(1000 / TARGET_FRAME_TIME_MS);
  }

  getQualityReport(): {
    level: number;
    quality: string;
    targetFPS: number;
    maxTextureSize: number;
    maxBlurRadius: number;
    kernelTaps: number;
    memoryPressure: number;
    deviceType: string;
  } {
    return {
      level: this.qualityLevel,
      quality: this.getBlurQuality(),
      targetFPS: this.getTargetFPS(),
      maxTextureSize: this.getMaxTextureSize(),
      maxBlurRadius: this.getMaxBlurRadius(),
      kernelTaps: this.getKernelTaps(),
      memoryPressure: this.memoryPressure,
      deviceType: 'universal'
    };
  }
}
