const CURRENCY_PREFIX = /^(?:R\$|BRL)\s*/iu;
const CURRENCY_SUFFIX = /\s*(?:R\$|BRL)$/iu;

function positiveFinite(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseFormattedAmount(value: string): number | null {
  const commaCount = value.match(/,/gu)?.length ?? 0;
  const dotCount = value.match(/\./gu)?.length ?? 0;

  if (commaCount === 0 && dotCount === 0) {
    return /^\d+$/u.test(value) ? positiveFinite(Number(value)) : null;
  }

  if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = value.lastIndexOf(",") > value.lastIndexOf(".")
      ? ","
      : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    const [integerPart, fractionPart, ...extraParts] = value.split(decimalSeparator);

    if (
      integerPart === undefined
      || fractionPart === undefined
      || extraParts.length > 0
      || !/^\d{1,3}(?:[.,]\d{3})+$/u.test(integerPart)
      || !integerPart.includes(groupingSeparator)
      || !/^\d{1,2}$/u.test(fractionPart)
    ) {
      return null;
    }

    const normalized = `${integerPart.replaceAll(groupingSeparator, "")}.${fractionPart}`;
    return positiveFinite(Number(normalized));
  }

  const separator = commaCount === 1 ? "," : ".";
  if ((separator === "," ? commaCount : dotCount) !== 1) {
    return null;
  }

  const [integerPart, fractionPart] = value.split(separator);
  if (
    integerPart === undefined
    || fractionPart === undefined
    || !/^\d+$/u.test(integerPart)
    || !/^\d{1,2}$/u.test(fractionPart)
  ) {
    return null;
  }

  return positiveFinite(Number(`${integerPart}.${fractionPart}`));
}

export function parseBrl(input: unknown): number | null {
  if (typeof input === "number") {
    return positiveFinite(input);
  }

  if (typeof input !== "string") {
    return null;
  }

  const amount = input
    .trim()
    .replace(CURRENCY_PREFIX, "")
    .replace(CURRENCY_SUFFIX, "")
    .replace(/\s/gu, "");

  return parseFormattedAmount(amount);
}
