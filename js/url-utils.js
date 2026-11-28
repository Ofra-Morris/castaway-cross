export function normalizeDirectoryPathname(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return pathname;
  }

  if (pathname.endsWith("/")) {
    return pathname;
  }

  const lastSegment = pathname.split("/").pop();
  const looksLikeFile = lastSegment?.includes(".");

  if (looksLikeFile) {
    return pathname;
  }

  return `${pathname}/`;
}

/**
 * The seed as it appears in a random-puzzle link (?seed=): base 36, except
 * where that comes out all digits. parsePuzzleSeed reads an all-digit seed as
 * decimal (older links used decimal), so seed 36, base 36 "10", would come back
 * as 10 -- a different puzzle. Those seeds are written in decimal instead,
 * which reads back as themselves; every other link is unchanged.
 */
export function encodePuzzleSeed(seed) {
  const base36 = seed.toString(36);
  return /^\d+$/.test(base36) ? seed.toString(10) : base36;
}

/** The seed a ?seed= value names, or null when it names none. */
export function parsePuzzleSeed(rawSeed) {
  if (typeof rawSeed !== "string") return null;

  const value = rawSeed.trim();
  if (!value || !/^[0-9a-z]+$/i.test(value)) return null;

  const parsed = /^\d+$/.test(value)
    ? Number.parseInt(value, 10)
    : Number.parseInt(value, 36);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed >>> 0;
}

export function buildPuzzleUrlFromHref(href, {
  mode,
  seed,
  customCategories,
  schemaVersion,
  dailyDateKey
}) {
  const url = new URL(href);
  const params = new URLSearchParams(url.search);

  const dailyPathPattern = /^(.*)\/daily\/\d{4}-\d{2}-\d{2}\/$/;
  let normalizedPathname = normalizeDirectoryPathname(url.pathname) || "/";
  while (dailyPathPattern.test(normalizedPathname)) {
    const match = normalizedPathname.match(dailyPathPattern);
    const basePath = match?.[1] || "";
    normalizedPathname = normalizeDirectoryPathname(basePath || "/") || "/";
  }
  url.pathname = normalizedPathname;

  params.delete("mode");
  params.delete("seed");
  params.delete("cats");
  params.delete("v");

  if (mode === "daily") {
    if (typeof dailyDateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dailyDateKey)) {
      const basePath = normalizeDirectoryPathname(url.pathname) || "/";
      url.pathname = `${basePath}daily/${dailyDateKey}/`;
    }
  } else if (mode === "random" && Number.isInteger(seed)) {
    params.set("mode", "random");
    params.set("seed", encodePuzzleSeed(seed));
    params.set("v", schemaVersion);
  } else if (mode === "custom" && Array.isArray(customCategories) && customCategories.length === 6) {
    params.set("mode", "custom");
    params.set("cats", customCategories.join(","));
    params.set("v", schemaVersion);
  }

  const search = params.toString();
  url.search = search ? `?${search}` : "";

  return url.toString();
}
