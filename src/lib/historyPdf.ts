import { jsPDF } from "jspdf";
import { getHistory, type Valuation } from "./history";
import { formatEur, formatUsd } from "./formatPrice";

// jsPDF no pinta bien el espacio sin ruptura que Intl pone junto al símbolo.
const pdfText = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
import { translations } from "./i18n";

const NAVY: [number, number, number] = [26, 31, 58];
const GOLD: [number, number, number] = [212, 168, 83];
const CREAM: [number, number, number] = [245, 240, 230];
const MUTED: [number, number, number] = [120, 128, 150];

const DATA_MARKER = "%%LUME-DATA:";
const DATA_END = ":LUME-END%%";

const L = {
  es: {
    title: "Informe de Tasaciones",
    subtitle: "Lume — Tasación experta por fotografía",
    generated: "Generado el",
    body: "Cuerpo del informe",
    summary: "Resumen",
    identification: "Identificación",
    confidence: "Confianza",
    notes: "Notas",
    sources: "Fuentes",
    category: "Categoría",
    total: "Tasaciones incluidas",
    rangeEur: "Rango total estimado (EUR)",
    rangeUsd: "Rango total estimado (USD)",
    average: "Valor medio estimado (EUR)",
    byCategory: "Por categoría",
    page: "Página",
    empty: "No hay tasaciones en el historial.",
    footer: "©2026 FMEDIAG - Lume v1.0",
  },
  en: {
    title: "Appraisal Report",
    subtitle: "Lume — Expert appraisal from photos",
    generated: "Generated on",
    body: "Report body",
    summary: "Summary",
    identification: "Identification",
    confidence: "Confidence",
    notes: "Notes",
    sources: "Sources",
    category: "Category",
    total: "Appraisals included",
    rangeEur: "Total estimated range (EUR)",
    rangeUsd: "Total estimated range (USD)",
    average: "Average estimated value (EUR)",
    byCategory: "By category",
    page: "Page",
    empty: "No appraisals in history.",
    footer: "©2026 FMEDIAG - Lume v1.0",
  },
};

export type PdfLang = keyof typeof L;

const M = 46; // margen
const W = 595.28; // A4 pt
const H = 841.89;

/** Convierte bytes a string binario en bloques, evitando el límite de argumentos
 * de String.fromCharCode(...bytes) que revienta con payloads grandes (fotos en base64). */
function bytesToBinaryString(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32768
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

/** Traduce el nivel de confianza (high/medium/low) al idioma del informe. */
function confidenceLabel(value: string, lang: PdfLang): string {
  const dict = translations[lang].confidenceLevels as Record<string, string>;
  return dict[value] ?? value;
}

function ts(v: Valuation): number {
  return typeof v.createdAt === "number" ? v.createdAt : new Date(v.createdAt).getTime();
}

/** Traduce la clave interna de categoría (p.ej. "realestate") al idioma del informe.
 * Si la clave no está en el diccionario (categoría antigua o inesperada), la capitaliza
 * en vez de mostrarla en minúsculas sin tratar. */
function categoryLabel(key: string, lang: PdfLang): string {
  const dict = translations[lang].categories as Record<string, string>;
  if (dict[key]) return dict[key];
  return key
    .split(" ")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export async function exportHistoryPdf(lang: PdfLang = "es"): Promise<void> {
  const items = await getHistory();
  const t = L[lang];
  const locale = lang === "es" ? "es-ES" : "en-US";
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  let page = 1;
  const decorate = () => {
    // marco premium
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.8);
    doc.rect(M - 14, M - 14, W - (M - 14) * 2, H - (M - 14) * 2);
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(t.footer, W / 2, H - M + 10, { align: "center" });
    doc.text(`${t.page} ${page}`, W - M, H - M + 10, { align: "right" });
  };

  // ---------- Portada / Título ----------
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, W, H, "F");
  doc.setFillColor(...GOLD);
  doc.rect(0, 250, W, 3, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(34);
  doc.setTextColor(...GOLD);
  doc.text("LUME", W / 2, 210, { align: "center" });
  doc.setFontSize(24);
  doc.setTextColor(...CREAM);
  doc.text(t.title, W / 2, 300, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(...MUTED);
  doc.text(t.subtitle, W / 2, 326, { align: "center" });
  doc.text(`${t.generated} ${new Date().toLocaleString(locale)}`, W / 2, 348, { align: "center" });
  doc.setFontSize(11);
  doc.setTextColor(...GOLD);
  doc.text(`${t.total}: ${items.length}`, W / 2, 380, { align: "center" });
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(t.footer, W / 2, H - 40, { align: "center" });

  // ---------- Cuerpo ----------
  let y = M + 8;
  const newBodyPage = () => {
    doc.addPage();
    page += 1;
    decorate();
    y = M + 8;
  };
  if (items.length === 0) {
    newBodyPage();
  }

  const ensure = (need: number) => {
    if (y + need > H - M - 6) {
      newBodyPage();
    }
  };

  const heading = (text: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...NAVY);
    doc.text(text, M, y);
    y += 8;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(1.4);
    doc.line(M, y, W - M, y);
    y += 20;
  };

  const label = (text: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...GOLD);
    doc.text(text.toUpperCase(), M + 12, y);
    y += 12;
  };

  const paragraph = (text: string, indent = 12) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(60, 64, 80);
    const lines = doc.splitTextToSize(text, W - M * 2 - indent * 2) as string[];
    for (const line of lines) {
      ensure(14);
      doc.text(line, M + indent, y);
      y += 13;
    }
    y += 4;
  };

  if (items.length === 0) {
    heading(t.body);
    paragraph(t.empty);
  }

  // Cada tasación ocupa su propia página
  items.forEach((v, i) => {
    newBodyPage();
    heading(`${t.body} ${i + 1}/${items.length}`);
    // tarjeta
    const top = y - 14;
    doc.setFillColor(250, 248, 244);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.6);

    const startY = y;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11.5);
    doc.setTextColor(...NAVY);
    const titleLines = doc.splitTextToSize(`${i + 1}. ${v.title}`, W - M * 2 - 24) as string[];
    for (const line of titleLines) {
      ensure(16);
      doc.text(line, M + 12, y);
      y += 15;
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(new Date(v.createdAt).toLocaleString(locale), M + 12, y);
    y += 14;

    // Fotografía original de la tasación (se conserva intacta en el PDF)
    if (v.thumbnail && v.thumbnail.startsWith("data:image")) {
      try {
        const props = doc.getImageProperties(v.thumbnail);
        const maxW = W - M * 2 - 24;
        const maxH = 230;
        const scale = Math.min(maxW / props.width, maxH / props.height, 1);
        const iw = props.width * scale;
        const ih = props.height * scale;
        ensure(ih + 16);
        const ix = (W - iw) / 2;
        doc.setDrawColor(...GOLD);
        doc.setLineWidth(0.8);
        doc.addImage(v.thumbnail, ix, y, iw, ih, undefined, "FAST");
        doc.rect(ix, y, iw, ih);
        y += ih + 16;
      } catch (e) {
        console.warn("No se pudo incrustar la imagen en el PDF", e);
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...GOLD);
    doc.text(
      pdfText(
        `${formatEur(v.priceEurMin)} – ${formatEur(v.priceEurMax)}   |   ${formatUsd(v.priceUsdMin)} – ${formatUsd(v.priceUsdMax)}`,
      ),
      M + 12,
      y,
    );
    y += 16;

    if (v.category) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text(`${t.category}: ${categoryLabel(v.category, lang)}`, M + 12, y);
      y += 14;
    }

    if (v.identification) {
      label(t.identification);
      paragraph(v.identification);
    }
    if (v.confidence) {
      label(t.confidence);
      paragraph(confidenceLabel(String(v.confidence), lang));
    }
    if (v.notes) {
      label(t.notes);
      paragraph(v.notes);
    }
    if (v.sources && v.sources.length > 0) {
      label(t.sources);
      paragraph(v.sources.join(" · "));
    }

    // línea separadora dorada suave
    ensure(12);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.4);
    doc.line(M + 12, y, W - M - 12, y);
    y += 18;
    void top;
    void startY;
  });

  // ---------- Resumen ----------
  doc.addPage();
  page += 1;
  decorate();
  y = M + 8;
  heading(t.summary);

  const sumMin = items.reduce((a, v) => a + v.priceEurMin, 0);
  const sumMax = items.reduce((a, v) => a + v.priceEurMax, 0);
  const sumMinU = items.reduce((a, v) => a + v.priceUsdMin, 0);
  const sumMaxU = items.reduce((a, v) => a + v.priceUsdMax, 0);
  const avg = items.length ? (sumMin + sumMax) / 2 / items.length : 0;

  const row = (k: string, val: string) => {
    ensure(20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(k, M + 12, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...NAVY);
    doc.text(val, W - M - 12, y, { align: "right" });
    y += 10;
    doc.setDrawColor(230, 224, 210);
    doc.setLineWidth(0.4);
    doc.line(M + 12, y, W - M - 12, y);
    y += 14;
  };

  row(t.total, String(items.length));
  row(t.rangeEur, pdfText(`${formatEur(sumMin)} – ${formatEur(sumMax)}`));
  row(t.rangeUsd, pdfText(`${formatUsd(sumMinU)} – ${formatUsd(sumMaxU)}`));
  row(t.average, pdfText(formatEur(avg)));

  const byCat = new Map<string, number>();
  for (const v of items) {
    const k = v.category ?? "other";
    byCat.set(k, (byCat.get(k) ?? 0) + 1);
  }
  if (byCat.size > 0) {
    y += 10;
    label(t.byCategory);
    for (const [k, n] of Array.from(byCat.entries()).sort((a, b) => b[1] - a[1])) {
      row(categoryLabel(k, lang), String(n));
    }
  }

  const oldest = items.length ? new Date(Math.min(...items.map(ts))) : null;
  const newest = items.length ? new Date(Math.max(...items.map(ts))) : null;
  if (oldest && newest) {
    y += 6;
    paragraph(
      lang === "es"
        ? `Periodo cubierto: ${oldest.toLocaleDateString(locale)} — ${newest.toLocaleDateString(locale)}.`
        : `Period covered: ${oldest.toLocaleDateString(locale)} — ${newest.toLocaleDateString(locale)}.`,
    );
  }

  doc.setProperties({ title: t.title, subject: t.subtitle, creator: "Lume", author: "FMEDIAG" });

  // Datos incrustados tras %%EOF: los lectores de PDF los ignoran,
  // pero permiten reimportar el historial completo desde el propio PDF.
  const payload = JSON.stringify({ app: "Lume", kind: "valuation-history", version: 1, items });
  const encoded = btoa(bytesToBinaryString(new TextEncoder().encode(payload)));
  const pdfBytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  const tail = new TextEncoder().encode(`\n${DATA_MARKER}${encoded}${DATA_END}\n`);
  const fileName = `lume-informe-tasaciones-${new Date().toISOString().slice(0, 10)}.pdf`;

  // En la app Android (WebView) no funcionan las descargas con enlaces blob:
  // entregamos el PDF a la app nativa, que lo guarda en Descargas.
  const bridge = (
    window as unknown as {
      LumeAndroid?: { saveFile?: (base64: string, name: string, mime: string) => boolean };
    }
  ).LumeAndroid;
  if (bridge && typeof bridge.saveFile === "function") {
    const all = new Uint8Array(pdfBytes.length + tail.length);
    all.set(pdfBytes, 0);
    all.set(tail, pdfBytes.length);
    bridge.saveFile(btoa(bytesToBinaryString(all)), fileName, "application/pdf");
    return;
  }

  const blob = new Blob([pdfBytes, tail], { type: "application/pdf" });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Extrae el historial incrustado en un PDF Premium generado por Lume. */
export function extractHistoryJsonFromPdf(raw: string): string {
  const start = raw.indexOf(DATA_MARKER);
  const end = raw.indexOf(DATA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("PDF_NO_LUME_DATA");
  }
  const encoded = raw.slice(start + DATA_MARKER.length, end).replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
