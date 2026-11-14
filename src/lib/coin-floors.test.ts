import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  applyCoinPriceGuards,
  collectorFloorEur,
  isModernBullion,
  meltValue,
  numismaticMeltMultiplier,
  typicalFineWeightG,
  type CoinId,
  type MetalSpots,
} from "./coin-floors.ts";

const spots: MetalSpots = {
  goldUsd: 3800,
  silverUsd: 45,
  eurPerUsd: 0.86,
  goldEur: 3800 * 0.86,
  silverEur: 45 * 0.86,
};

function coin(partial: Partial<CoinId> & Pick<CoinId, "title">): CoinId {
  return {
    country: "Spain",
    denomination: "",
    year: "1795",
    mint: "Madrid",
    seriesName: "",
    metal: "gold",
    estimatedFineWeightG: null,
    certifier: "none",
    grade: null,
    certNumber: null,
    isLikelyReproduction: false,
    marketType: "numismatic",
    identification: partial.title,
    searchQuery: partial.title,
    confidence: "high",
    ...partial,
  };
}

const meltQuote = {
  priceEurMin: 2500,
  priceEurMax: 2800,
  priceUsdMin: 2900,
  priceUsdMax: 3300,
  notes: "Valor de fundición.",
};

describe("coin floors — 8 escudos / onza", () => {
  it("knows the fine gold weight", () => {
    const id = coin({ title: "8 escudos Carlos IV 1795 Madrid", denomination: "8 escudos" });
    assert.equal(typicalFineWeightG(id), 23.68);
  });

  it("does not treat colonial gold as bullion", () => {
    const id = coin({
      title: "8 escudos onza 1795",
      denomination: "8 escudos",
      marketType: "unknown",
    });
    assert.equal(isModernBullion(id), false);
  });

  it("lifts a melt quote by ~€10k for an ungraded onza", () => {
    const id = coin({ title: "España 8 escudos 1795 onza", denomination: "8 escudos" });
    const guarded = applyCoinPriceGuards(meltQuote, id, spots);
    // Melt ≈ €2.5k; XF floor 9500 and ~4.2× melt (~€11k) — must not stay at 2500.
    assert.ok(guarded.priceEurMin >= 9000, `min ${guarded.priceEurMin}`);
    assert.ok(guarded.priceEurMax >= guarded.priceEurMin);
    const lift = guarded.priceEurMin - meltQuote.priceEurMin;
    assert.ok(lift >= 6500, `only lifted ${lift} €`);
  });

  it("uses a higher floor for NGC MS-63", () => {
    const id = coin({
      title: "8 escudos 1795",
      denomination: "8 escudos",
      certifier: "NGC",
      grade: "MS-63",
    });
    assert.ok((collectorFloorEur(id) ?? 0) >= 18000);
    const guarded = applyCoinPriceGuards(meltQuote, id, spots);
    assert.ok(guarded.priceEurMin >= 18000, `min ${guarded.priceEurMin}`);
  });
});

describe("bullion is not inflated", () => {
  it("leaves a Krugerrand near melt", () => {
    const id = coin({
      title: "Krugerrand 1 oz 1975",
      denomination: "1 oz",
      country: "South Africa",
      marketType: "bullion",
      estimatedFineWeightG: 31.1,
    });
    assert.equal(isModernBullion(id), true);
    assert.equal(collectorFloorEur(id), null);
    const melt = meltValue(id, spots)!;
    const guarded = applyCoinPriceGuards(
      {
        priceEurMin: Math.round(melt.eur),
        priceEurMax: Math.round(melt.eur * 1.05),
        priceUsdMin: Math.round(melt.usd),
        priceUsdMax: Math.round(melt.usd * 1.05),
        notes: "spot",
      },
      id,
      spots,
    );
    assert.ok(guarded.priceEurMin < melt.eur * 1.1);
  });
});

describe("100 pesetas", () => {
  it("does not quote melt for Alfonso XII 100 pesetas", () => {
    const id = coin({
      title: "100 pesetas Alfonso XII 1877 DEM",
      denomination: "100 pesetas",
      year: "1877",
    });
    const guarded = applyCoinPriceGuards(meltQuote, id, spots);
    assert.ok(guarded.priceEurMin >= 3500);
    assert.ok(numismaticMeltMultiplier(id) >= 1.6);
  });
});

describe("reproductions and low confidence", () => {
  it("does not apply collector floors", () => {
    const fake = coin({
      title: "8 escudos",
      denomination: "8 escudos",
      isLikelyReproduction: true,
    });
    assert.equal(collectorFloorEur(fake), null);
    const low = coin({ title: "8 escudos", denomination: "8 escudos", confidence: "low" });
    assert.equal(collectorFloorEur(low), null);
  });
});

describe("plated / filled coins are never valued as solid metal", () => {
  it("meltValue returns null even with a large total weight", () => {
    const plated = coin({
      title: "Moneda conmemorativa chapada en oro 1oz",
      denomination: "1 oz",
      estimatedFineWeightG: 31.1,
      platedOrFilled: true,
    });
    assert.equal(meltValue(plated, spots), null);
  });

  it("does not apply the collector floor for a plated 8 escudos replica", () => {
    const plated = coin({
      title: "8 escudos réplica chapada",
      denomination: "8 escudos",
      platedOrFilled: true,
    });
    assert.equal(collectorFloorEur(plated), null);
    assert.equal(numismaticMeltMultiplier(plated), 1);
  });

  it("does not lift a plated souvenir toward melt/collector value", () => {
    const plated = coin({
      title: "Medalla souvenir chapada en oro",
      denomination: "",
      estimatedFineWeightG: 30,
      platedOrFilled: true,
      marketType: "unknown",
    });
    const cheapQuote = {
      priceEurMin: 5,
      priceEurMax: 15,
      priceUsdMin: 5,
      priceUsdMax: 16,
      notes: "souvenir plateado",
    };
    const guarded = applyCoinPriceGuards(cheapQuote, plated, spots);
    // Sin el arreglo, esto se habría inflado a ~€1.100 (30 g de "oro" al spot).
    assert.equal(guarded.priceEurMin, cheapQuote.priceEurMin);
    assert.equal(guarded.priceEurMax, cheapQuote.priceEurMax);
  });
});
