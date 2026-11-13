export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

const VERSION_PATTERN =
  /^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?$/;

const isNumericIdentifier = (identifier: string) => /^\d+$/.test(identifier);

export const parseVersion = (input: string): ParsedVersion | undefined => {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return undefined;

  const prerelease = match[4] ? match[4].split(".") : [];
  if (
    prerelease.some(
      (identifier) =>
        isNumericIdentifier(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    )
  ) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5] ? match[5].split(".") : [],
  };
};

const compareIdentifiers = (a: string, b: string): -1 | 0 | 1 => {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);

  if (aNumeric && bNumeric) {
    const aValue = Number(a);
    const bValue = Number(b);
    if (aValue === bValue) return 0;
    return aValue < bValue ? -1 : 1;
  }

  if (aNumeric) return -1;
  if (bNumeric) return 1;

  if (a === b) return 0;
  return a < b ? -1 : 1;
};

const compareCore = (a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 => {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
};

export const compareParsedVersions = (
  a: ParsedVersion,
  b: ParsedVersion,
): -1 | 0 | 1 => {
  const core = compareCore(a, b);
  if (core !== 0) return core;

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aIdentifier = a.prerelease[index];
    const bIdentifier = b.prerelease[index];

    if (aIdentifier === undefined) return -1;
    if (bIdentifier === undefined) return 1;

    const comparison = compareIdentifiers(aIdentifier, bIdentifier);
    if (comparison !== 0) return comparison;
  }

  return 0;
};

export const compareVersions = (a: string, b: string): -1 | 0 | 1 | null => {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return null;
  return compareParsedVersions(parsedA, parsedB);
};

export const isNewerVersion = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) === 1;

export const isSameVersion = (a: string, b: string): boolean =>
  compareVersions(a, b) === 0;
