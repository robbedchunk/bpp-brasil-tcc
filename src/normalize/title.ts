const PLACEHOLDER_TITLE = /^(?:produto(?:\s+aguardando\s+observa[cç][aã]o(?:\s+descritiva)?)?|product|unknown|sem\s+t[ií]tulo|n\/?a)$/iu;

/** A classification title must contain human-readable lexical evidence, not
 * merely the retailer's numeric/SKU identifier or an internal placeholder. */
export function isDescriptiveProductTitle(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const title = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return title.length >= 2
    && title.length <= 500
    && /\p{L}/u.test(title)
    && !PLACEHOLDER_TITLE.test(title)
    && !/[\u0000-\u001f\u007f]/u.test(title);
}
