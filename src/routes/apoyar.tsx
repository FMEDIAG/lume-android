import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Globe, Heart } from "lucide-react";
import { translations, type Lang } from "@/lib/i18n";

// Liberapay se abre directamente: cada donante realiza la donación desde
// su propia cuenta en la página oficial de Liberapay.
const LIBERAPAY_URL = "https://liberapay.com/FMEDIAG/donate";

export const Route = createFileRoute("/apoyar")({
  validateSearch: (search: Record<string, unknown>) => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Apoya Lume — Support Lume" },
      {
        name: "description",
        content: "Apoya el proyecto Lume con una donación segura por Liberapay. Support the Lume project with a Liberapay donation.",
      },
      { property: "og:title", content: "Apoya Lume — Support Lume" },
      {
        property: "og:description",
        content: "Apoya el proyecto Lume con una donación segura por Liberapay. Support the Lume project with a Liberapay donation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ApoyarPage,
});

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

function ApoyarPage() {
  const [lang, setLang] = useLangState();
  const t = translations[lang];
  const [donated, setDonated] = useState(false);

  const handleDonate = () => {
    setDonated(true);
    window.open(LIBERAPAY_URL, "_blank", "noopener");
  };

  const openLiberapay = () => {
    window.open(LIBERAPAY_URL, "_blank", "noopener");
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background px-4 py-8">
      <BackgroundGlow />
      <div className="relative mx-auto max-w-md">
        <div className="flex items-center justify-between">
          <Link
            to="/"
            className="glass-crystal flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {t.back}
          </Link>
          <LangToggle lang={lang} setLang={setLang} />
        </div>

        <section className="mt-6">
          <div className="glass-crystal rounded-3xl p-5">
            {donated ? (
              <div className="text-center">
                <Heart className="mx-auto h-8 w-8 text-primary" />
                <h1 className="mt-2 text-lg font-semibold text-gradient-gold">{t.donation.thanksTitle}</h1>
                <p className="mt-2 text-sm leading-relaxed text-foreground/80">
                  {t.donation.thanksBody}
                </p>
                <div className="mt-5 space-y-3">
                  <button
                    onClick={openLiberapay}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-crystal px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-glow transition"
                  >
                    <Heart className="h-4 w-4" /> {t.donation.reopenLiberapay}
                  </button>
                  <Link
                    to="/"
                    className="flex w-full items-center justify-center rounded-2xl glass-crystal px-6 py-3 text-sm font-semibold text-primary"
                  >
                    {t.donation.backHome}
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Heart className="h-5 w-5 text-primary" />
                  <h1 className="text-lg font-semibold text-gradient-gold">{t.donation.title}</h1>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-foreground/80">{t.donation.lead}</p>

                <div className="mt-5 space-y-4">
                  <button
                    onClick={handleDonate}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-crystal px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-glow transition"
                  >
                    <Heart className="h-4 w-4" /> {t.donation.pay}
                  </button>
                  <Link
                    to="/"
                    className="flex w-full items-center justify-center rounded-2xl glass-crystal px-6 py-3 text-sm font-semibold text-primary"
                  >
                    {t.donation.backHome}
                  </Link>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
