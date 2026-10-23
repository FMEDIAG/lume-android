export function formatNumber(value: number): string {
  if (typeof value !== "number" || isNaN(value)) return "0";
  if (value < 1) return value.toFixed(2);
  if (value >= 1000) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPrice(value: number): string {
  const options =
    value < 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : value >= 1000
        ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
        : { minimumFractionDigits: 0, maximumFractionDigits: 2 };

  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    ...options,
  }).format(value);
}

// Importes con la convención de cada moneda, igual en cualquier navegador:
// euro a la española (1.250,50 €) y dólar a la estadounidense ($1,250.50).
function moneyDigits(value: number): Intl.NumberFormatOptions {
  if (value < 1) return { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (value >= 1000) return { minimumFractionDigits: 0, maximumFractionDigits: 0 };
  const digits = Number.isInteger(value) ? 0 : 2;
  return { minimumFractionDigits: digits, maximumFractionDigits: digits };
}

export function formatEur(value: number): string {
  const v = typeof value === "number" && !isNaN(value) ? value : 0;
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    // Sin esto, es-ES escribe 1250 en vez de 1.250 (el tipo de TypeScript aún no lo admite).
    useGrouping: "always" as unknown as boolean,
    ...moneyDigits(v),
  }).format(v);
}

export function formatUsd(value: number): string {
  const v = typeof value === "number" && !isNaN(value) ? value : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    ...moneyDigits(v),
  }).format(v);
}
