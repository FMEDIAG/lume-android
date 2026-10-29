# Restore valuate.functions.ts

The file `src/lib/valuate.functions.ts` was temporarily broken during a large-file push.

**Quick restore from last good commit:**

```bash
git checkout dcfb1c818d6fe932985687b47568ed6e186f2d18 -- src/lib/valuate.functions.ts
```

Then re-apply the site: multi-query integration from `src/lib/referenceSites.ts` (already on main):

1. Import `buildSiteQueries` and `formatSiteSearchInstructions` from `@/lib/referenceSites`.
2. After identification, build `siteQueries` and append `siteSearchLine` to the user prompt.

The full patched file is available in the agent session artifacts as `valuate.functions.RESTORED.ts`.
