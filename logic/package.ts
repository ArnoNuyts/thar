/**
 * Published npm identity. The application name stays `todotui` for now, but
 * the package is published under a scope.
 */
export const PACKAGE_NAME = "@arnoarnoarno/thar";

export const packageSpecifier = (version = "latest"): string =>
  `${PACKAGE_NAME}@${version}`;
