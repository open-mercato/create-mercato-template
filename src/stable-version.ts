// Stable version helpers. Shared by the stock table generator
// (scripts/build-stock-table.mts, which runs this file directly with Node's
// type stripping) and the tool, so this module imports nothing.

/** True for a stable `major.minor.patch` version; prereleases such as `-canary-` are not. */
export function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

/** Compares two stable `major.minor.patch` versions numerically (0.10.0 is newer than 0.9.0). */
export function compareStableVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
