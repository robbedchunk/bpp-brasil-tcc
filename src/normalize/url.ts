/** Query keys used only for attribution and safe to remove from product URLs. */
export const TRACKING_QUERY_KEYS = new Set([
  "_ga",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "utm_campaign",
  "utm_content",
  "utm_creative_format",
  "utm_id",
  "utm_marketing_tactic",
  "utm_medium",
  "utm_source",
  "utm_source_platform",
  "utm_term",
  "wbraid",
]);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

function isAllowedHostname(hostname: string, allowedDomains: string[]): boolean {
  const candidate = normalizeHostname(hostname);

  return allowedDomains.some((domain) => {
    const allowed = normalizeHostname(domain.trim());
    return allowed.length > 0 && (candidate === allowed || candidate.endsWith(`.${allowed}`));
  });
}

function normalizeCollectionScopedProductPath(pathname: string): string {
  const match = /^\/collections\/[^/]+\/products\/(.+)$/u.exec(pathname);
  return match?.[1] === undefined ? pathname : `/products/${match[1]}`;
}

export function canonicalizeRetailerUrl(
  input: string,
  baseUrl: string,
  allowedDomains: string[],
): string {
  const url = new URL(input, baseUrl);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL protocol is not allowed: ${url.protocol}`);
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("URL credentials are not allowed");
  }

  if (!isAllowedHostname(url.hostname, allowedDomains)) {
    throw new Error(`URL domain is not allowed: ${url.hostname}`);
  }

  url.hostname = normalizeHostname(url.hostname);
  url.pathname = normalizeCollectionScopedProductPath(url.pathname);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}
