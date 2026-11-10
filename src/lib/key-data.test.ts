import { describe, expect, it } from "vitest";
import { REFERENCE_SITES_BY_CATEGORY } from "./referenceSites";
import { capConfidenceForMissing, KEY_DATA_BY_CATEGORY, keyDataPrompt } from "./key-data";

describe("key-data", () => {
  it("todas las categorías con webs de referencia tienen sus datos clave", () => {
    for (const cat of Object.keys(REFERENCE_SITES_BY_CATEGORY)) {
      expect(KEY_DATA_BY_CATEGORY[cat], cat).toBeDefined();
      expect(KEY_DATA_BY_CATEGORY[cat].es.length).toBe(KEY_DATA_BY_CATEGORY[cat].en.length);
    }
  });
  it("el prompt incluye inmuebles y sellos", () => {
    const p = keyDataPrompt("es");
    expect(p).toContain("realestate: ubicación");
    expect(p).toContain("stamps: país");
  });
  it("sin datos esenciales, inmuebles, vehículos y barcos no pasan de confianza baja", () => {
    expect(capConfidenceForMissing("high", "realestate", 2)).toBe("low");
    expect(capConfidenceForMissing("medium", "vehicles", 1)).toBe("low");
    expect(capConfidenceForMissing("high", "realestate", 0)).toBe("high");
    expect(capConfidenceForMissing("high", "stamps", 3)).toBe("high");
  });
});
