import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";

/**
 * Temporary stub. Restore full implementation with:
 *   git checkout dcfb1c818d6fe932985687b47568ed6e186f2d18 -- src/lib/valuate.functions.ts
 * Then apply site: multi-query from referenceSites.ts (already on main).
 *
 * Full patched file available from agent artifacts: valuate.functions.ts
 */
export const valuateItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async () => {
    setResponseStatus(503);
    throw new Error(
      "Modulo de tasacion en restauracion. Ejecuta: git checkout dcfb1c818d6fe932985687b47568ed6e186f2d18 -- src/lib/valuate.functions.ts",
    );
  });
