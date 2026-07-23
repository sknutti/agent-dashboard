/**
 * Clamps a number to a range.
 * @param n - The number to clamp
 * @param min - The minimum value
 * @param max - The maximum value
 * @returns The clamped value: min if n < min, max if n > max, n otherwise
 */
export function clamp(n: number, min: number, max: number): number {
  if (n < min) {
    return min;
  }
  if (n > max) {
    return max;
  }
  return n;
}
