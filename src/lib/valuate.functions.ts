import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";

// Temporary stub while full module is restored. See src/lib/referenceSites.ts for site: search support.
export const valuateItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async () => {
    setResponseStatus(503);
    throw new Error("Valuation module is being updated. Please retry in a few minutes.");
  });
