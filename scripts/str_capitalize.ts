/**
 * Capitalizes the first character of a string.
 * @param s - The string to capitalize
 * @returns The string with its first character upper-cased and the rest unchanged, or s unchanged if empty
 */
export function capitalize(s: string): string {
  if (s.length === 0) {
    return s;
  }
  return s[0]!.toUpperCase() + s.slice(1);
}
