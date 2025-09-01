// geocode.js
const fetch = require("node-fetch");

async function queryNominatim(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("polygon_geojson", "1");
  url.searchParams.set("extratags", "1");

  const res = await fetch(url, {
    headers: { "User-Agent": "IDS-DisasterAPI/1.0 (kostas@example.com)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function geocode(place) {
  // 1. Try original query
  let data = await queryNominatim(place);

  // If no results
  if (data.length === 0) return null;

  let best = data[0];

  // 2. If no polygon (only Point or LineString), try fallbacks
  if (!best.geojson || !["Polygon", "MultiPolygon"].includes(best.geojson.type)) {
    const fallbacks = [
      `Δήμος ${place}`,
      `Περιφερειακή Ενότητα ${place}`
    ];

    for (const fb of fallbacks) {
      const fbData = await queryNominatim(fb);
      if (fbData.length > 0 && fbData[0].geojson && ["Polygon", "MultiPolygon"].includes(fbData[0].geojson.type)) {
        best = fbData[0];
        break;
      }
    }
  }

  return {
    name: place,
    lat: parseFloat(best.lat),
    lon: parseFloat(best.lon),
    display: best.display_name,
    geojson: best.geojson,        // 🚀 now more likely to be a polygon
    extratags: best.extratags || {}
  };
}

// Example usage
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const places = ["Mpalas", "Ioannina", "Πρεβέζης"];
  for (const p of places) {
    const result = await geocode(p);
    console.dir(result, { depth: null });
    await sleep(1200); // 1.2s between requests
  }
})();
