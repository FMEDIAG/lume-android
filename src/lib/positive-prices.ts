type Prices = {
  priceEurMin: number;
  priceEurMax: number;
  priceUsdMin: number;
  priceUsdMax: number;
};

/** Repair missing endpoints only from received positive prices, never a made-up floor. */
export function positivePrices<T extends Prices>(input: T, eurPerUsd: number): T | null {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const range = (a: number, b: number): [number, number] | null => {
    const values = [a, b].filter(positive);
    return values.length ? [Math.min(...values), Math.max(...values)] : null;
  };
  let eur = range(input.priceEurMin, input.priceEurMax);
  let usd = range(input.priceUsdMin, input.priceUsdMax);
  if (!eur && !usd) return null;
  if (!eur || !usd) {
    if (!positive(eurPerUsd)) return null;
    if (!eur && usd) eur = [usd[0] * eurPerUsd, usd[1] * eurPerUsd];
    if (!usd && eur) usd = [eur[0] / eurPerUsd, eur[1] / eurPerUsd];
  }
  if (!eur || !usd) return null;
  return { ...input, priceEurMin: eur[0], priceEurMax: eur[1], priceUsdMin: usd[0], priceUsdMax: usd[1] };
}