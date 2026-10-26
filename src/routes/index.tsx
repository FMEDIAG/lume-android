import { toast } from "sonner";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Camera,
  Images,
  Sparkles,
  History,
  Trash2,
  Save,
  Check,
  Globe,
  Focus,
  Heart,
} from "lucide-react";
import { CameraCapture } from "@/components/CameraCapture";
import { IntroScreen, INTRO_SEEN_KEY } from "@/components/IntroScreen";

import { valuateItem } from "@/lib/valuate.functions";
import { detectCategory } from "@/lib/detect-category.functions";
import { translations, type Lang } from "@/lib/i18n";
import { saveValuation, type Valuation } from "@/lib/history";
import { formatEur, formatUsd } from "@/lib/formatPrice";
import { extractPricePerSqm } from "@/lib/pricePerSqm";
//
// Pon esto en false para ocultar el motivo técnico que se añade entre corchetes a los avisos de error.
const SHOW_ERROR_DETAILS = false;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Lume" },
      {
        name: "description",
        content:
          "Lume tasa tus objetos por fotografía usando IA y bases de datos públicas como eBay y Wikipedia. Rangos en EUR y USD, ES/EN.",
      },
      { property: "og:title", content: "Lume" },
      {
        property: "og:description",
        content:
          "Lume tasa tus objetos por fotografía usando IA y bases de datos públicas como eBay y Wikipedia. Rangos en EUR y USD, ES/EN.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Index,
});

interface Photo {
  id: string;
  dataUrl: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file: File, max = 1024, quality = 0.8): Promise<string> {
  const url = await fileToDataUrl(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("No se pudo leer la imagen"));
    img.src = url;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

// Miniatura ligera solo para clasificar: sube mucho más rápido que la foto completa.
async function makeThumbnail(dataUrl: string, max = 512, quality = 0.6): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("No se pudo leer la imagen"));
    img.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function useLangState(): [Lang, (l: Lang) => void] {
  const [lang, setLang] = useState<Lang>("es");
  useEffect(() => {
    const read = () => setLang((localStorage.getItem("lume:lang") as Lang) || "es");
    read();
    window.addEventListener("lume:lang", read);
    return () => window.removeEventListener("lume:lang", read);
  }, []);
  return [
    lang,
    (l) => {
      localStorage.setItem("lume:lang", l);
      window.dispatchEvent(new Event("lume:lang"));
    },
  ];
}

function Index() {
  const navigate = useNavigate();
  const [lang, setLang] = useLangState();
  const t = translations[lang];
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [context, setContext] = useState("");
  const [category, setCategory] = useState<string>("auto");
  const [condition, setCondition] = useState<string>("unknown");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<
    (Omit<Valuation, "id" | "createdAt" | "thumbnail"> & { thumbnail: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [macroOpen, setMacroOpen] = useState(false);
  const [showIntro, setShowIntro] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setShowIntro(!localStorage.getItem(INTRO_SEEN_KEY));
    } catch {
      // localStorage no disponible: mostramos la intro igualmente, sin persistir la preferencia.
      setShowIntro(true);
    }
  }, []);

  const valuate = useServerFn(valuateItem);
  const detect = useServerFn(detectCategory);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [suggestedConfidence, setSuggestedConfidence] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<Array<{ category: string; confidence: number }>>([]);
  const [detecting, setDetecting] = useState(false);
  const detectedForRef = useRef<string | null>(null);

  // Auto-detect category from the latest photo whenever photos change.
  useEffect(() => {
    // Solo la primera foto decide la categoría: evita una llamada de IA por cada foto añadida.
    const latest = photos[0];
    if (!latest) {
      setDetecting(false);
      setSuggested(null);
      setSuggestedConfidence(null);
      setCandidates([]);
      detectedForRef.current = null;
      return;
    }
    if (detectedForRef.current === latest.id) return;
    detectedForRef.current = latest.id;
    setDetecting(true);
    makeThumbnail(latest.dataUrl)
      .catch(() => latest.dataUrl)
      .then((thumb) => detect({ data: { dataUrl: thumb, lang } }))
      .then((r) => {
        if (detectedForRef.current !== latest.id) return;
        setSuggested(r.category);
        setSuggestedConfidence(r.confidence);
        setCandidates(r.candidates.slice(0, 3));
        // Only set category if it's not "auto" or if user hasn't manually changed it
        if (category === "auto") {
          setCategory(r.category);
        }
      })
      .catch((e) => {
        if (detectedForRef.current !== latest.id) return;
        console.error(e);
        setSuggested(null);
        setSuggestedConfidence(null);
        setCandidates([]);
        toast(
          lang === "es"
            ? "No se pudo detectar la categoría ahora: elígela a mano."
            : "Could not detect the category right now: please choose it manually.",
        );
      })
      .finally(() => {
        if (detectedForRef.current === latest.id) setDetecting(false);
      });
  }, [photos, lang, detect, category]);

  const canValuate = photos.length >= 1 && !loading;

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const newPhotos: Photo[] = [];
    for (const f of Array.from(files)) {
      try {
        const dataUrl = await compressImage(f);
        newPhotos.push({ id: crypto.randomUUID(), dataUrl });
      } catch {
        toast.error(
          lang === "es"
            ? `No se pudo procesar la foto ${f.name}`
            : `Could not process photo ${f.name}`,
        );
      }
    }
    if (newPhotos.length) setPhotos((p) => [...p, ...newPhotos].slice(0, 3));
  }

  async function onValuate() {
    setLoading(true);
    setError(null);
    setResult(null);
    setSaved(false);
    try {
      const payload = {
        photos: photos.map((p) => ({ dataUrl: p.dataUrl })),
        context,
        category,
        condition,
        lang,
      };
      // El servidor ya reintenta por su cuenta; repetirlo aquí duplicaba la espera.
      const r = await valuate({ data: payload });
      setResult({ ...r, thumbnail: photos[0].dataUrl });
    } catch (e) {
      console.error(e);
      const quota = e instanceof Error && e.message.includes("quota");
      const detail =
        SHOW_ERROR_DETAILS && e instanceof Error && e.message.includes(": ")
          ? ` [${e.message.split(": ").slice(1).join(": ")}]`
          : "";
      setError(
        (quota
          ? lang === "es"
            ? "Hay mucha demanda de IA en este momento. Espera un minuto e inténtalo de nuevo."
            : "AI demand is high right now. Please wait a minute and try again."
          : lang === "es"
            ? "No se pudo completar la tasación. Revisa el contexto o inténtalo de nuevo en unos minutos."
            : "The valuation could not be completed. Check the context or try again in a few minutes.") +
          detail,
      );
    } finally {
      setLoading(false);
    }
  }

  async function onSave() {
    if (!result) {
      toast.error(lang === "es" ? "No hay resultado para guardar" : "No result to save");
      return;
    }

    try {
      const v: Valuation = {
        id: String(Date.now()),
        createdAt: Date.now(),
        title: result.title || "Objeto tasado",
        identification: result.identification || "",
        priceEurMin: Number(result.priceEurMin) || 0,
        priceEurMax: Number(result.priceEurMax) || 0,
        priceUsdMin: Number(result.priceUsdMin) || 0,
        priceUsdMax: Number(result.priceUsdMax) || 0,
        confidence: result.confidence || "medium",
        notes: result.notes || "",
        sources: Array.isArray(result.sources) ? result.sources : [],
        thumbnail: result.thumbnail || "",
        category: category && category !== "auto" ? category : "other",
      };

      await saveValuation(v);

      setSaved(true);
      toast.success(lang === "es" ? "Guardado en el historial" : "Saved to history");
    } catch (err) {
      toast.error((lang === "es" ? "Error al guardar: " : "Save error: ") + String(err));
    }
  }

  function reset() {
    setPhotos([]);
    setContext("");
    setCategory("auto");
    setCondition("unknown");
    setResult(null);
    setError(null);
    setSaved(false);
    setSuggested(null);
    setSuggestedConfidence(null);
    setCandidates([]);
    detectedForRef.current = null;
  }

  return (
    <>
      {showIntro && (
        <IntroScreen
          onStart={(openCamera) => {
            setShowIntro(false);
            if (openCamera) setMacroOpen(true);
          }}
        />
      )}
      <div className={showIntro === false ? "relative min-h-screen overflow-hidden" : "hidden"}>
        <BackgroundGlow />
        <div className="relative mx-auto max-w-xl px-5 pb-24 pt-8">
          <header className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full ring-1 ring-primary/40 shadow-glow">
                <img src="/Lume.jpg" alt={t.logoAlt} className="h-full w-full object-cover" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-gradient-gold">
                  {t.homeHeading}
                </h1>
                <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  {t.tagline}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <LangToggle lang={lang} setLang={setLang} />
              <Link
                to="/history"
                className="glass-crystal flex h-10 w-10 items-center justify-center rounded-full text-primary transition hover:scale-105"
                aria-label={t.viewHistory}
              >
                <History className="h-5 w-5" />
              </Link>
            </div>
          </header>

          {!result && (
            <section className="mt-8">
              <p className="text-sm leading-relaxed text-muted-foreground">{t.subtitle}</p>

              <div className="mt-6 grid grid-cols-3 gap-3">
                <button
                  onClick={() => cameraRef.current?.click()}
                  className="glass-crystal group flex flex-col items-center justify-center gap-2 rounded-2xl px-3 py-6 transition hover:scale-[1.02]"
                >
                  <Camera className="h-7 w-7 text-primary transition group-hover:scale-110" />
                  <span className="text-xs font-medium text-foreground">{t.takePhoto}</span>
                </button>
                <button
                  onClick={() => setMacroOpen(true)}
                  className="glass-crystal group flex flex-col items-center justify-center gap-2 rounded-2xl px-3 py-6 transition hover:scale-[1.02]"
                >
                  <Focus className="h-7 w-7 text-primary transition group-hover:scale-110" />
                  <span className="text-xs font-medium text-foreground">{t.macroPhoto}</span>
                </button>
                <button
                  onClick={() => galleryRef.current?.click()}
                  className="glass-crystal group flex flex-col items-center justify-center gap-2 rounded-2xl px-3 py-6 transition hover:scale-[1.02]"
                >
                  <Images className="h-7 w-7 text-primary transition group-hover:scale-110" />
                  <span className="text-xs font-medium text-foreground">{t.fromGallery}</span>
                </button>
              </div>
              {macroOpen && (
                <CameraCapture
                  t={{ ...t, lang }}
                  onClose={() => setMacroOpen(false)}
                  onCapture={(res) => {
                    setPhotos((p) =>
                      [...p, { id: crypto.randomUUID(), dataUrl: res.dataUrl }].slice(0, 3),
                    );
                    setMacroOpen(false);
                  }}
                />
              )}

              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => onFiles(e.target.files)}
              />
              <input
                ref={galleryRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => onFiles(e.target.files)}
              />

              {photos.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                    {t.photosCount(photos.length)}
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {photos.map((p) => (
                      <div
                        key={p.id}
                        className="relative aspect-square overflow-hidden rounded-lg ring-1 ring-primary/30"
                      >
                        <img src={p.dataUrl} alt="" className="h-full w-full object-cover" />
                        <button
                          onClick={() => setPhotos((prev) => prev.filter((x) => x.id !== p.id))}
                          className="absolute right-1 top-1 rounded-full bg-background/70 p-1 text-primary backdrop-blur"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-5 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                    {t.category}
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-xl border border-primary/20 bg-input px-3 py-2.5 text-sm text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                  >
                    {(Object.keys(t.categories) as Array<keyof typeof t.categories>).map((k) => (
                      <option key={k} value={k}>
                        {t.categories[k]}
                      </option>
                    ))}
                  </select>
                  {detecting && (
                    <p className="mt-1 text-[10px] text-muted-foreground/80">✨ {t.detecting}</p>
                  )}
                  {!detecting && suggested && suggested in t.categories && (
                    <div className="mt-1.5 space-y-1">
                      <p className="text-[10px] text-primary/80">
                        ✨ {t.suggested}: {t.categories[suggested as keyof typeof t.categories]}
                        {suggestedConfidence !== null && (
                          <span className="ml-1 font-semibold">
                            ({Math.round(suggestedConfidence)}%)
                          </span>
                        )}
                        {category !== suggested && (
                          <button
                            type="button"
                            onClick={() => setCategory(suggested)}
                            className="ml-1.5 underline hover:text-primary"
                          >
                            {t.applySuggestion}
                          </button>
                        )}
                      </p>
                      {candidates.length > 1 && (
                        <div className="flex flex-wrap gap-1">
                          <span className="text-[10px] text-muted-foreground/70">
                            {t.candidates}:
                          </span>
                          {candidates.map((c) =>
                            c.category in t.categories ? (
                              <button
                                key={c.category}
                                type="button"
                                onClick={() => setCategory(c.category)}
                                className={`rounded-full border px-1.5 py-0.5 text-[10px] transition ${
                                  category === c.category
                                    ? "border-primary/60 bg-primary/15 text-primary"
                                    : "border-primary/20 text-muted-foreground hover:border-primary/40 hover:text-primary"
                                }`}
                              >
                                {t.categories[c.category as keyof typeof t.categories]}{" "}
                                {Math.round(c.confidence)}%
                              </button>
                            ) : null,
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                    {t.condition}
                  </label>
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="w-full rounded-xl border border-primary/20 bg-input px-3 py-2.5 text-sm text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
                  >
                    {(Object.keys(t.conditions) as Array<keyof typeof t.conditions>).map((k) => (
                      <option key={k} value={k}>
                        {t.conditions[k]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder={(t.contextHints as Record<string, string>)[category] ?? t.context}
                rows={2}
                className="mt-3 w-full resize-none rounded-xl border border-primary/20 bg-input px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/40"
              />

              <button
                disabled={!canValuate}
                onClick={onValuate}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-crystal px-6 py-4 text-base font-semibold text-primary-foreground shadow-glow transition disabled:glass-crystal disabled:text-muted-foreground disabled:shadow-none"
              >
                {loading ? (
                  <>
                    <Sparkles className="h-5 w-5 animate-spin" /> {t.valuating}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-5 w-5" /> {t.valuate}
                  </>
                )}
              </button>
              {photos.length < 1 && (
                <p className="mt-3 text-center text-xs text-muted-foreground">{t.minPhotos}</p>
              )}
              {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}
              <p className="mt-6 text-center text-[11px] text-muted-foreground/70">{t.poweredBy}</p>
              <Link
                to="/apoyar"
                search={{ step: undefined }}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/30 glass-crystal px-6 py-3 text-sm font-semibold text-primary transition hover:shadow-glow"
              >
                <Heart className="h-4 w-4" /> {t.donate}
              </Link>
              <img
                src="/fmediag-logo.png"
                alt="FMEDIAG"
                className="mx-auto mt-3 h-9 w-9 rounded-full ring-1 ring-primary/30"
              />
              <p className="mt-2 text-center text-xs font-bold text-muted-foreground/80">
                ©2026 FMEDIAG - Lume v1.0
              </p>
            </section>
          )}

          {result && (
            <ResultCard
              t={t}
              result={result}
              saved={saved}
              onSave={onSave}
              onReset={reset}
              onHistory={() => navigate({ to: "/history" })}
            />
          )}
        </div>
      </div>
    </>
  );
}

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="glass-crystal flex items-center gap-0.5 rounded-full p-1 text-xs">
      <Globe className="ml-1.5 h-3.5 w-3.5 text-primary" />
      {(["es", "en"] as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className={`rounded-full px-2.5 py-1 font-semibold uppercase transition ${
            lang === l ? "bg-gradient-crystal text-primary-foreground" : "text-muted-foreground"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function BackgroundGlow() {
  return (
    <>
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse,oklch(0.72_0.2_45/40%),transparent_70%)] blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-[400px] w-[400px] translate-x-1/3 rounded-full bg-[radial-gradient(ellipse,oklch(0.92_0.18_95/25%),transparent_70%)] blur-3xl" />
    </>
  );
}

function ResultCard({
  t,
  result,
  saved,
  onSave,
  onReset,
  onHistory,
}: {
  t: (typeof translations)["es"] | (typeof translations)["en"];
  result: Omit<Valuation, "id" | "createdAt">;
  saved: boolean;
  onSave: () => void;
  onReset: () => void;
  onHistory: () => void;
}) {
  const confColor = useMemo(() => {
    if (result.confidence === "high") return "text-primary";
    if (result.confidence === "medium") return "text-accent";
    return "text-muted-foreground";
  }, [result.confidence]);

  return (
    <section className="mt-8 space-y-4">
      <div className="glass-crystal rounded-3xl p-5">
        <div className="flex items-start gap-4">
          <img
            src={result.thumbnail}
            alt=""
            className="h-20 w-20 shrink-0 rounded-xl object-cover ring-1 ring-primary/40"
          />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">{t.result}</p>
            <h2 className="mt-1 text-xl font-semibold text-gradient-gold">{result.title}</h2>
            <p className={`mt-1 text-xs font-medium uppercase ${confColor}`}>
              {t.confidence}:{" "}
              {t.confidenceLevels[result.confidence as keyof typeof t.confidenceLevels] ??
                result.confidence}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <PriceCard label="EUR" currency="EUR" min={result.priceEurMin} max={result.priceEurMax} />
          <PriceCard label="USD" currency="USD" min={result.priceUsdMin} max={result.priceUsdMax} />
        </div>

        <div className="mt-5">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            {t.identification}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-foreground/90">{result.identification}</p>
        </div>

        {result.notes && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{t.notes}</p>
            {extractPricePerSqm(result.notes).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {extractPricePerSqm(result.notes).map((p) => (
                  <span
                    key={p}
                    className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums leading-tight text-primary"
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-1 text-sm leading-relaxed text-foreground/80">{result.notes}</p>
          </div>
        )}

        {result.sources && result.sources.length > 0 && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{t.sources}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {result.sources.map((s, i) => (
                <span
                  key={i}
                  className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-primary"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onSave}
          disabled={saved}
          className="glass-crystal flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-primary disabled:opacity-70"
        >
          {saved ? (
            <>
              <Check className="h-4 w-4" /> {t.saved}
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> {t.saveHistory}
            </>
          )}
        </button>
        {saved ? (
          <button
            onClick={onHistory}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-crystal px-4 py-3 text-sm font-semibold text-primary-foreground"
          >
            <History className="h-4 w-4" /> {t.viewHistory}
          </button>
        ) : (
          <button
            onClick={onReset}
            className="flex flex-1 items-center justify-center rounded-2xl bg-gradient-crystal px-4 py-3 text-sm font-semibold text-primary-foreground"
          >
            {t.clear}
          </button>
        )}
      </div>
    </section>
  );
}
function PriceCard({
  label,
  currency,
  min,
  max,
}: {
  label: string;
  currency: "EUR" | "USD";
  min: number;
  max: number;
}) {
  const fmt = currency === "EUR" ? formatEur : formatUsd;

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3 text-center">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gradient-gold">
        {fmt(min)} – {fmt(max)}
      </p>
    </div>
  );
}
