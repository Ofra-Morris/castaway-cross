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
    params.set("seed", seed.toString(36));
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
