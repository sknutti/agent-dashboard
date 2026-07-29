/**
 * Formats a count with a noun into human-readable label for UI badges.
 * Handles singular (1), plural (>1), and empty state (0) cases.
 *
 * @param n - The count value
 * @param noun - The singular form of the noun (e.g., "item", "file")
 * @returns A formatted string suitable for display in a badge:
 *          - "1 <noun>" when n === 1
 *          - "<n> <noun>s" when n > 1
 *          - "no <noun>s" when n === 0
 */
export function countLabel(n: number, noun: string): string {
  if (n === 1) {
    return `1 ${noun}`;
  }
  if (n === 0) {
    return `no ${noun}s`;
  }
  return `${n} ${noun}s`;
}
