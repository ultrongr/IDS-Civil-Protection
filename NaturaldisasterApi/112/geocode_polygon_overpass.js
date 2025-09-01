// geocode_polygon_overpass.js
// Resolve Greek places to polygons when possible; fallback to place=* (suburb, neighborhood, etc.)

const fetch = require("node-fetch");
const osmtogeojson = require("osmtogeojson");

const UA = "IDS-DisasterAPI/1.0 (your-email-or-site)";

/* ----------------------- Helpers ----------------------- */
function bbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
function areaOfGeom(geom) {
  const [minX, minY, maxX, maxY] = bbox(geom);
  return (maxX - minX) * (maxY - minY);
}
function isPolygonal(geom) {
  return geom && (geom.type === "Polygon" || geom.type === "MultiPolygon");
}

/* ----------------------- Overpass ----------------------- */
function buildAdminQuery(name, adminLevel) {
  const safe = name.replace(/"/g, '\\"');
  return `
[out:json][timeout:25];
area["ISO3166-1"="GR"]->.gr;
rel(area.gr)["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"="${safe}"];
out body; >; out skel qt;
`;
}

function buildPlaceQuery(name, placeTypes) {
  const safe = name.replace(/"/g, '\\"');
  // Search for name exact match across node/way/relation with any of the place=* types
  // Using if: to ensure tag equality on name (handles multiple langs inconsistently, but works decently)
  return `
[out:json][timeout:25];
area["ISO3166-1"="GR"]->.gr;

(
  ${placeTypes.map(t => `node(area.gr)["place"="${t}"](if:t["name"]=="${safe}");`).join("\n  ")}
  ${placeTypes.map(t => `way(area.gr)["place"="${t}"](if:t["name"]=="${safe}");`).join("\n  ")}
  ${placeTypes.map(t => `rel(area.gr)["place"="${t}"](if:t["name"]=="${safe}");`).join("\n  ")}
);
out body; >; out skel qt;
`;
}

async function overpass(ql) {
  const url = "https://overpass-api.de/api/interpreter";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA
    },
    body: "data=" + encodeURIComponent(ql)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Overpass HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

function pickBestFeature(osmJson) {
  if (!osmJson?.elements?.length) return null;
  const fc = osmtogeojson(osmJson); // FeatureCollection
  if (!fc.features?.length) return null;

  // Prefer polygonal features; if none, fall back to any geometry (point/line).
  const polys = fc.features.filter(f => isPolygonal(f.geometry));
  if (polys.length) {
    polys.sort((a, b) => areaOfGeom(b.geometry) - areaOfGeom(a.geometry));
    return polys[0];
  }
  // No polygons — pick the first (usually a node for suburb/neighbourhood)
  return fc.features[0];
}

/* ----------------------- Public API ----------------------- */
async function geocodePolygon(place) {
  // 1) Try administrative boundaries first (Δήμος -> Π.Ε. -> Περιφέρεια)
  for (const lvl of [8, 6, 4]) {
    const ql = buildAdminQuery(place, lvl);
    const resp = await overpass(ql);
    const feat = pickBestFeature(resp);
    if (feat) {
      return {
        name: place,
        kind: "administrative",
        admin_level: String(lvl),
        osm_id: feat.properties?.id,
        display: feat.properties?.tags?.name || place,
        geometry_type: feat.geometry?.type || null,
        geojson: feat.geometry || null
      };
    }
  }

  // 2) Fallback to place=* (covers suburbs/neighbourhoods like "Εγλυκάδα")
  const placeTypes = ["suburb","neighbourhood","quarter","village","hamlet","town","city","locality"];
  const qlPlace = buildPlaceQuery(place, placeTypes);
  const respPlace = await overpass(qlPlace);
  const featPlace = pickBestFeature(respPlace);
  if (featPlace) {
    return {
      name: place,
      kind: "place",
      admin_level: null,
      osm_id: featPlace.properties?.id,
      display: featPlace.properties?.tags?.name || place,
      geometry_type: featPlace.geometry?.type || null,
      geojson: featPlace.geometry || null
    };
  }

  // 3) Nothing found
  return null;
}

/* ----------------------- Example usage ----------------------- */
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  const places = ["Εγλυκάδα"];
  for (const p of places) {
    try {
      const r = await geocodePolygon(p);
      console.dir(r, { depth: null });
    } catch (e) {
      console.error(`Failed for ${p}:`, e.message);
    }
    await sleep(1100); // be polite to Overpass
  }
})();

module.exports = { geocodePolygon };
