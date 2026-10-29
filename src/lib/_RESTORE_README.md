# Restore valuate.functions.ts + site: multi-query

`valuate.functions.ts` is temporarily a stub (tool payload limit on ~66KB files).
`referenceSites.ts` and `site-search.patch` are already on main.

## One-shot restore + enable site searches

```bash
# 1) Restore last good full module
git checkout dcfb1c818d6fe932985687b47568ed6e186f2d18 -- src/lib/valuate.functions.ts

# 2) Apply site: multi-query patch
git apply src/lib/site-search.patch
# if git apply fails, try:
#   patch -p1 < src/lib/site-search.patch

# 3) Clean up
git rm -f src/lib/_RESTORE_README.md
# optional: keep site-search.patch for history, or remove it
# git rm -f src/lib/site-search.patch

git add src/lib/valuate.functions.ts
git commit -m "fix: restore valuate + enable site: multi-query on reference domains"
git push origin main
```

After this, each valuation will run mandatory searches like:
`Rolex Submariner 16610 sold site:ebay.com`
`Rolex Submariner 16610 site:chrono24.com`
etc., according to the category map in `referenceSites.ts`.
