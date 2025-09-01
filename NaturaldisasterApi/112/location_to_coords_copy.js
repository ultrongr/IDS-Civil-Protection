// geocode.js
// Geocode + polygon borders via LocationIQ only

const fetch = require("node-fetch");

const UA = "IDS-DisasterAPI/1.0 (kostas@example.com)";
const LOCATIONIQ_KEY = "pk.6d341298e6b9fb535e15d4f2458460c4"; // put this in your .env

async function geocode(place) {
  if (!LOCATIONIQ_KEY) throw new Error("Missing LOCATIONIQ_KEY in env");

  const url = new URL("https://us1.locationiq.com/v1/search.php");
  url.searchParams.set("key", LOCATIONIQ_KEY);
  url.searchParams.set("q", place);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("polygon_geojson", "1"); // <-- include boundaries
  url.searchParams.set("normalizeaddress", "1");

  const res = await fetch(url, {
    headers: { "User-Agent": UA }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const best = data[0];
  return {
    name: place,
    lat: parseFloat(best.lat),
    lon: parseFloat(best.lon),
    display: best.display_name,
    geojson: best.geojson || null,   // 🚀 polygon if available
    extratags: best.extratags || {}
  };
}

// Example usage
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const places = ["Eglykada", "Ioannina", "Πρεβέζης"];
  for (const p of places) {
    try {
      const result = await geocode(p);
      console.dir(result, { depth: null });
    } catch (e) {
      console.error(`Failed for ${p}:`, e.message);
    }
    await sleep(1000); // be kind to free API quota
  }
})();
