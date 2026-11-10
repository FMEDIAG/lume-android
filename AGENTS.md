<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Request mobile camera permission only after the first-run introduction CTA, then release the probe stream before opening the camera UI; this preserves Android gesture requirements and avoids holding two streams.
- Build category-specific reference queries for general and coin valuations; accept comparable pages only when their normalized URLs appear in provider citations, prioritize sold prices, and label unsupported ranges as low-confidence estimates because website names alone are not evidence.
- Watch valuations use src/lib/watch-retail.ts (Firecrawl search via connector gateway, retail-only URLs, prices must appear in the scraped page) — keeps figures backed by pages actually consulted.
- General valuations try evidence-capable search before ungrounded generation and retry only invalid received output, not network failures; watch currency lookup runs alongside extraction with a bounded wait — avoids serial work without changing coin or Magic pipelines.
- Validate general valuation prices with positivePrices; repair missing bounds only from received positive values and retry empty prices, never return a zero fallback or invent a minimum.
