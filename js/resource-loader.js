// ------------------------------------------------------------
// Resource Loader Helpers
// ------------------------------------------------------------

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

const jsonResponseCache = new Map();

function buildCacheKey({ label, candidates, cacheKey }) {
  if (cacheKey) {
    return cacheKey;
  }

  return `${label}::${candidates.join("|")}`;
}

function getRuntimeBasePath() {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.location.pathname === "/") {
    return "";
  }

  const [firstSegment] = window.location.pathname
    .split("/")
    .filter(Boolean);

  return firstSegment ? `/${firstSegment}` : "";
}

export function buildCandidateUrls({
  preferredAbsolutePath,
  relativeFromModule,
  moduleUrl
}) {
  const candidates = [];

  if (preferredAbsolutePath) {
    const runtimeBasePath = getRuntimeBasePath();

    if (preferredAbsolutePath.startsWith("/castaway-cross/")) {
      const strippedPreferredPath = preferredAbsolutePath.replace("/castaway-cross", "");
      const runtimeRewrite = (() => {
        if (!runtimeBasePath) return null;
        if (preferredAbsolutePath.startsWith("/castaway-cross/frontend/")) {
          return preferredAbsolutePath.replace("/castaway-cross/frontend", `${runtimeBasePath}/frontend`);
        }
        return preferredAbsolutePath.replace("/castaway-cross", runtimeBasePath);
      })();

      if (!runtimeBasePath) {
        candidates.push(strippedPreferredPath);
      }

      // In static previews served under /frontend/*, prioritize runtime-rewritten
      // frontend URLs to avoid extra failing requests before categories render.
      if (runtimeRewrite && preferredAbsolutePath.includes("/frontend/")) {
        candidates.push(runtimeRewrite);
      }

      candidates.push(preferredAbsolutePath);
      candidates.push(strippedPreferredPath);

      if (runtimeRewrite && !preferredAbsolutePath.includes("/frontend/")) {
        candidates.push(runtimeRewrite);
      }
    } else {
      candidates.push(preferredAbsolutePath);
    }
  }

  if (relativeFromModule && moduleUrl) {
    candidates.push(new URL(relativeFromModule, moduleUrl).toString());
  }

  return dedupe(candidates);
}

export async function fetchJsonWithFallback({
  label,
  candidates,
  fetchImpl = fetch,
  useCache = true,
  cacheKey
}) {
  const resolvedCacheKey = buildCacheKey({ label, candidates, cacheKey });

  if (useCache && jsonResponseCache.has(resolvedCacheKey)) {
    return jsonResponseCache.get(resolvedCacheKey);
  }

  const request = (async () => {
    let lastError = null;

    for (const url of candidates) {
      try {
        const res = await fetchImpl(url);

        if (!res.ok) {
          throw new Error(`Request failed (${res.status} ${res.statusText})`);
        }

        return await res.json();
      } catch (error) {
        lastError = error;
        console.warn(`[resource-loader] Failed to load ${label} from ${url}`, error);
      }
    }

    throw new Error(
      `[resource-loader] Unable to load ${label} from all configured sources. Last error: ${lastError?.message || "unknown"}`
    );
  })();

  if (useCache) {
    jsonResponseCache.set(resolvedCacheKey, request);
  }

  try {
    return await request;
  } catch (error) {
    if (useCache) {
      jsonResponseCache.delete(resolvedCacheKey);
    }

    throw error;
  }
}
