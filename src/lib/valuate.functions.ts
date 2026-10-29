import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  chatCompletion,
  clientIp,
  getMetalSpots,
  isAllowedOrigin,
  requestOriginHost,
  roundMoney,
  type MetalSpots,
} from "@/lib/lume-ai";
import { anchorToComparables } from "@/lib/comparables";
import {
  buildSiteQueries,
  formatSiteSearchInstructions,
} from "@/lib/referenceSites";
import {
  applyCoinPriceGuards,
  typicalFineWeightG,
  type CoinCertifier,
  type CoinId,
  type CoinMarketType,
  type CoinMetal,
} from "@/lib/coin-floors";

// NOTE: file temporarily incomplete - restoring next
export const valuateItem = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(async () => {
    throw new Error("Valuation module is being restored; retry in a moment");
  });
