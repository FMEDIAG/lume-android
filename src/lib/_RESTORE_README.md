# Restore valuate.functions.ts

The full `valuate.functions.ts` (~66KB) could not be pushed in one tool call (payload limit).

## Quick restore (app works again)

```bash
git fetch origin
git checkout dcfb1c818d6fe932985687b47568ed6e186f2d18 -- src/lib/valuate.functions.ts
git rm -f src/lib/_RESTORE_README.md
git commit -m "fix: restore valuate.functions.ts from last good commit"
git push origin main
```

## Then enable site: multi-query (3 edits)

`referenceSites.ts` is already on main.

1. Add import after comparables:
```ts
import {
  buildSiteQueries,
  formatSiteSearchInstructions,
} from "@/lib/referenceSites";
```

2. Replace the `queriesTxt` / `idLine` block with site-query generation (see agent message).

3. Append `+ siteSearchLine` to the userPrompt concatenation after `idLine`.
