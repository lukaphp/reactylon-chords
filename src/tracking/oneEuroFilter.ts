import type { Vec2 } from './types';

/**
 * 1€ Filter (Casiez et al., CHI 2012) for low-latency adaptive jitter reduction.
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrevMs: number | null = null;

  constructor(minCutoff = 1.5, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  setParams(minCutoff: number, beta: number, dCutoff = 1.0): void {
    this.minCutoff = Math.max(0.05, minCutoff);
    this.beta = Math.max(0, beta);
    this.dCutoff = Math.max(0.05, dCutoff);
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrevMs = null;
  }

  filter(value: number, timestampMs: number): number {
    if (this.xPrev === null || this.tPrevMs === null) {
      this.xPrev = value;
      this.dxPrev = 0;
      this.tPrevMs = timestampMs;
      return value;
    }

    const dtSec = Math.max((timestampMs - this.tPrevMs) / 1000, 1 / 240);
    this.tPrevMs = timestampMs;

    const alphaD = this.smoothingFactor(dtSec, this.dCutoff);
    const dx = (value - this.xPrev) / dtSec;
    const dxHat = this.exponentialSmoothing(alphaD, dx, this.dxPrev);
    this.dxPrev = dxHat;

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const alpha = this.smoothingFactor(dtSec, cutoff);
    const xHat = this.exponentialSmoothing(alpha, value, this.xPrev);
    this.xPrev = xHat;

    return xHat;
  }

  private smoothingFactor(dtSec: number, cutoffHz: number): number {
    const r = 2 * Math.PI * cutoffHz * dtSec;
    return r / (r + 1);
  }

  private exponentialSmoothing(alpha: number, x: number, xPrev: number): number {
    return alpha * x + (1 - alpha) * xPrev;
  }
}

export class OneEuroFilter2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(minCutoff = 1.5, beta = 0.08, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  setParams(minCutoff: number, beta: number, dCutoff = 1.0): void {
    this.fx.setParams(minCutoff, beta, dCutoff);
    this.fy.setParams(minCutoff, beta, dCutoff);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(point: Vec2, timestampMs: number): Vec2 {
    return {
      x: this.fx.filter(point.x, timestampMs),
      y: this.fy.filter(point.y, timestampMs),
    };
  }
}
