// Shim for `$env/dynamic/public`: webviews have no public environment.
export const env: Record<string, string | undefined> = {};
