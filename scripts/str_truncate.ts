/**
 * Truncates a string to a maximum length.
 * @param s - The string to truncate
 * @param max - The maximum length
 * @returns The original string if its length is <= max, otherwise s.slice(0, max)
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return s.slice(0, max);
}
