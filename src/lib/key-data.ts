// Datos clave por categoría: lo que cambia mucho el precio y una foto no suele mostrar.
// Se usa para que Lume pida SIEMPRE los mismos datos para el mismo tipo de objeto
// (el contexto sigue siendo opcional) y para no dar confianza alta cuando falta lo esencial.

export const KEY_DATA_BY_CATEGORY: Record<string, { es: string[]; en: string[] }> = {
  art: {
    es: ["autor o firma", "técnica y soporte", "medidas", "procedencia o certificado"],
    en: ["artist or signature", "technique and support", "dimensions", "provenance or certificate"],
  },
  cards: {
    es: ["juego y edición", "estado", "idioma", "si está graduada (PSA, BGS...)"],
    en: ["game and edition", "condition", "language", "whether it is graded (PSA, BGS...)"],
  },
  coins: {
    es: ["país y año", "ceca", "grado o certificadora"],
    en: ["country and year", "mint", "grade or certifier"],
  },
  stamps: {
    es: ["país", "número de catálogo", "estado (con o sin goma, centrado)", "si es sello suelto o carta"],
    en: ["country", "catalogue number", "condition (gum, centering)", "single stamp or cover"],
  },
  watches: {
    es: ["referencia exacta", "año", "caja y papeles", "estado"],
    en: ["exact reference", "year", "box and papers", "condition"],
  },
  jewelry: {
    es: ["material y quilates o contraste", "peso en gramos", "piedras", "marca"],
    en: ["material and karat or hallmark", "weight in grams", "stones", "brand"],
  },
  electronics: {
    es: ["modelo exacto", "año", "configuración o almacenamiento", "estado y accesorios"],
    en: ["exact model", "year", "configuration or storage", "condition and accessories"],
  },
  books: {
    es: ["título y edición", "año", "estado y encuadernación", "firma o dedicatoria"],
    en: ["title and edition", "year", "condition and binding", "signature or inscription"],
  },
  toys: {
    es: ["marca y modelo", "año", "caja original", "estado"],
    en: ["brand and model", "year", "original box", "condition"],
  },
  vinyl: {
    es: ["artista y título", "sello y prensado", "país", "estado del disco y la funda"],
    en: ["artist and title", "label and pressing", "country", "record and sleeve condition"],
  },
  fashion: {
    es: ["marca y modelo", "talla", "estado", "autenticidad"],
    en: ["brand and model", "size", "condition", "authenticity"],
  },
  sports: {
    es: ["equipo o jugador", "año", "autenticidad o certificado", "estado"],
    en: ["team or player", "year", "authenticity or certificate", "condition"],
  },
  memorabilia: {
    es: ["autenticidad o certificado", "persona o evento", "año", "estado"],
    en: ["authenticity or certificate", "person or event", "year", "condition"],
  },
  bonsai: {
    es: ["especie", "edad", "altura", "estilo"],
    en: ["species", "age", "height", "style"],
  },
  wine: {
    es: ["bodega", "añada", "formato de botella", "condiciones de almacenaje"],
    en: ["winery", "vintage", "bottle size", "storage conditions"],
  },
  furniture: {
    es: ["época o estilo", "material", "medidas", "autor o taller", "estado"],
    en: ["period or style", "material", "dimensions", "maker or workshop", "condition"],
  },
  militaria: {
    es: ["país y época", "autenticidad", "marcajes", "estado"],
    en: ["country and era", "authenticity", "markings", "condition"],
  },
  minerals: {
    es: ["especie", "localidad", "tamaño", "peso"],
    en: ["species", "locality", "size", "weight"],
  },
  gemstones: {
    es: ["tipo de gema", "quilates", "certificado", "tratamientos"],
    en: ["gem type", "carat weight", "certificate", "treatments"],
  },
  vehicles: {
    es: ["marca y modelo", "año", "kilometraje", "estado y mantenimiento"],
    en: ["make and model", "year", "mileage", "condition and maintenance"],
  },
  boats: {
    es: ["eslora", "año", "astillero", "motor y horas"],
    en: ["length", "year", "builder", "engine and hours"],
  },
  realestate: {
    es: ["ubicación (zona o dirección)", "superficie en m²", "estado y año", "extras (terraza, garaje, vistas)"],
    en: ["location (area or address)", "surface in m²", "condition and year", "extras (terrace, garage, views)"],
  },
  "music instrument": {
    es: ["marca y modelo", "año o época", "estado y reparaciones", "número de serie o autenticidad"],
    en: ["brand and model", "year or era", "condition and repairs", "serial number or authenticity"],
  },
  "luxury bags": {
    es: ["marca y modelo", "autenticidad o certificado", "estado", "caja y accesorios"],
    en: ["brand and model", "authenticity or certificate", "condition", "box and accessories"],
  },
  other: {
    es: ["autor o marca", "época o año", "medidas o peso", "estado"],
    en: ["maker or brand", "era or year", "dimensions or weight", "condition"],
  },
};

/** Categorías cuyo valor depende tanto de datos que no se ven que, si faltan, la confianza no puede ser alta. */
export const CONFIDENCE_CAPPED_WHEN_MISSING = new Set(["realestate", "vehicles", "boats"]);

/** Texto para el prompt de identificación: qué datos clave tiene cada categoría. */
export function keyDataPrompt(lang: "es" | "en"): string {
  const lines = Object.entries(KEY_DATA_BY_CATEGORY).map(([cat, v]) => `${cat}: ${v[lang].join("; ")}`);
  return lang === "es"
    ? `\nDatos clave por categoría:\n${lines.join("\n")}\nEn missingInfo incluye, por orden de importancia y como máximo 3, los datos clave de la categoría del objeto que NO consten en las fotos ni en el contexto. No incluyas los que ya consten.`
    : `\nKey data per category:\n${lines.join("\n")}\nIn missingInfo list, in order of importance and at most 3, the key data of the item's category that are NOT stated in the photos or the context. Do not list those already known.`;
}

/** Con datos esenciales sin conocer, en inmuebles, vehículos y embarcaciones la confianza no pasa de "baja". */
export function capConfidenceForMissing(
  confidence: "low" | "medium" | "high",
  category: string | undefined,
  missingCount: number,
): "low" | "medium" | "high" {
  if (missingCount > 0 && category && CONFIDENCE_CAPPED_WHEN_MISSING.has(category)) return "low";
  return confidence;
}
