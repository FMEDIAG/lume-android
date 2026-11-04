import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFichaQueries, buildSiteQueries, REFERENCE_SITES_BY_CATEGORY, referenceDomainsFor } from "./referenceSites.ts";

describe("búsqueda por referencias", () => {
  it("todas las categorías tienen consultas concretas y una abierta", () => {
    for (const category of Object.keys(REFERENCE_SITES_BY_CATEGORY)) {
      const queries = buildSiteQueries(["Modelo A 2020", "Modelo A edición", "Modelo A estado"], category);
      assert.ok(queries.some((q) => q.includes(`site:${referenceDomainsFor(category)[0]}`)), category);
      for (const domain of referenceDomainsFor(category).slice(0, 4)) {
        assert.ok(queries.some((q) => q.includes(`site:${domain}`)), `${category}: ${domain}`);
      }
      assert.ok(queries.includes("Modelo A 2020"), category);
      assert.ok(queries.length <= 10, category);
    }
  });
  it("auto y categoría ausente siguen pudiendo buscar", () => {
    assert.deepEqual(referenceDomainsFor(undefined), referenceDomainsFor("auto"));
    assert.ok(buildSiteQueries([], null, "Reloj fotografiado").length > 0);
  });
});
describe("buildFichaQueries", () => {
  it("pone primero la consulta con todos los datos exactos", () => {
    const q = buildFichaQueries({ maker: "Fender", model: "Stratocaster", reference: "", year: "1974" });
    assert.equal(q[0], "Fender Stratocaster 1974");
  });
  it("sin fabricante, modelo ni referencia no inventa consultas", () => {
    assert.deepEqual(buildFichaQueries({ year: "1974", material: "madera" }), []);
  });
});
