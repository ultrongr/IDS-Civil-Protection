// Requirements:
//   npm i mongoose node-fetch@3
// Usage examples:
//   node populate_wildfires_effis.js \
//     --from=2025-08-09T00:00:00 \
//     --to=2025-09-08T23:59:59 \
//     --country=EL \
//     --limit=9999 \
//     --clear=1
//
// Env (alternatives to CLI):
//   MONGO_URI=mongodb://127.0.0.1:27017/disasters
//   DATE_FROM=2025-08-09T00:00:00
//   DATE_TO=2025-09-08T23:59:59
//   COUNTRY=EL
//   LIMIT=9999
//   CLEAR=1                 # delete previous EFFIS wildfire docs first
//   TIMEZONE=Z              # for date parsing (default Z)

require('dotenv').config();
const mongoose = require('mongoose');
const Disaster = require('./models/Disaster');

// node-fetch v3 is ESM; import dynamically for CommonJS
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

let __turf = null;
async function ensureTurf() {
  if (__turf) return __turf;
  const [{ default: buffer }, { default: cleanCoords }] = await Promise.all([
    import('@turf/buffer'),
    import('@turf/clean-coords').catch(() => ({ default: (g) => g })), // optional
  ]);
  __turf = { buffer, cleanCoords };
  return __turf;
}

// config
const CLEAR    = /^(1|true|yes)$/i.test(process.env.CLEAR ?? '1'); // default ON
const PROVINCE = process.env.PROVINCE || 'Αχαΐα';
const DATE_FROM = process.env.DATE_FROM || new Date(Date.now() - 100*24*3600e3).toISOString();
const DATE_TO   = process.env.DATE_TO   || new Date().toISOString();
const COUNTRY   = process.env.COUNTRY   || 'EL';
const LIMIT     = Number(process.env.LIMIT || 9999);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/disasters';

const FIRST_WILDFIRE_APPEARANCE = new Date(Date.now() + 120e3).toISOString(); // 120 seconds
const SECOND_WILDFIRE_APPEARANCE = new Date(Date.now() + 10e3).toISOString(); // 10 seconds


// Base REST endpoint (use the same family the user provided)
const BASE = 'https://api.effis.emergency.copernicus.eu/rest/2/burntareas/current/';

function buildUrl(params) {
  const u = new URL(BASE);
  u.searchParams.set('country', COUNTRY);
  u.searchParams.set('lastupdate__gte', DATE_FROM);
  u.searchParams.set('lastupdate__lte', DATE_TO);
  u.searchParams.set('ordering', '-lastupdate');
  u.searchParams.set('limit', String(Math.max(1, LIMIT)));
  return u.toString();
}

// --- Greek diacritics-insensitive compare for province ---
function normalizeGreek(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toUpperCase();
}

function provinceMatches(p) {
  if (!PROVINCE) return true;
  return normalizeGreek(p) === normalizeGreek(PROVINCE);
}

// ---- Minimal WKT → GeoJSON (POLYGON / MULTIPOLYGON) ----
function parseWKT(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim();
  if (s.toUpperCase().startsWith('POLYGON')) return parseWKTPolygon(s);
  if (s.toUpperCase().startsWith('MULTIPOLYGON')) return parseWKTMultiPolygon(s);
  return null;
}
function parseWKTPolygon(s) {
  // POLYGON ((x y, x y, ...), (hole...), ...)
  const inner = s.replace(/^\s*POLYGON\s*\(\(/i, '').replace(/\)\)\s*$/, '');
  const rings = splitTop(inner, '),(');
  const coords = rings.map(r => r.split(',').map(pt => pt.trim()).filter(Boolean).map(pair => {
    const [x,y] = pair.split(/\s+/).map(Number); return [x,y];
  }));
  return { type: 'Polygon', coordinates: coords };
}
function parseWKTMultiPolygon(s) {
  // MULTIPOLYGON (((...)), ((...)), ...)
  const inner = s.replace(/^\s*MULTIPOLYGON\s*\(\(\(/i, '').replace(/\)\)\)\s*$/, '');
  const polys = splitTop(inner, ')\)\),\s*\(\(\(');
  const coordinates = polys.map(polyStr => {
    const rings = splitTop(polyStr, '),(');
    return rings.map(r => r.split(',').map(pt => pt.trim()).filter(Boolean).map(pair => {
      const [x,y] = pair.split(/\s+/).map(Number); return [x,y];
    }));
  });
  return { type: 'MultiPolygon', coordinates };
}
function splitTop(str, sepRegex) {
  // split on a regex that does not consider nested parentheses (our inputs are flat)
  return str.split(new RegExp(sepRegex, 'g'));
}

// ---- Geometry extraction from EFFIS items ----
function itemToGeoJSONGeometry(item) {
  // Prefer explicit GeoJSON, then EFFIS 'shape', then embedded JSON, then WKT-like fields
  if (item && typeof item === 'object') {
    if (item.geometry && item.geometry.type && item.geometry.coordinates) {
      return item.geometry;
    }
    if (item.shape && item.shape.type && item.shape.coordinates) {
      return item.shape; // <-- EFFIS provides geometry here
    }
    const gc = item.geom_geojson || item.geometry_geojson || item.geojson;
    if (gc) {
      try { const j = typeof gc === 'string' ? JSON.parse(gc) : gc; if (j.type && j.coordinates) return j; } catch {}
    }
    const wkt = item.geom || item.geometry || item.wkt || item.shape_wkt;
    const g = parseWKT(typeof wkt === 'string' ? wkt : null);
    if (g) return g;
  }
  return null;
}

function chooseDanger(areaHa) {
  const a = Number(areaHa || 0);
  if (a >= 1000) return 'extreme';
  if (a >= 300) return 'high';
  if (a >= 50) return 'moderate';
  return 'low';
}

function coerceDate(v) {
  if (!v) return null;
  const d = new Date(v); return isNaN(d) ? null : d;
}

async function fetchAll(url) {
  // Endpoint likely returns a DRF-style envelope: {count,next,previous,results: [...]}
  // But it might also return an array. We handle both and follow pagination via `next`.
  const out = [];
  let next = url;
  const headers = { 'Accept': 'application/json' };
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`EFFIS fetch ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
    const data = await res.json();
    if (Array.isArray(data)) { out.push(...data); break; }
    if (Array.isArray(data.results)) out.push(...data.results);
    else if (data.features && Array.isArray(data.features)) {
      // GeoJSON FeatureCollection
      for (const f of data.features) out.push({ ...f.properties, geometry: f.geometry });
    } else {
      // Unknown shape, try to see if there is a geometry field
      out.push(data);
      break;
    }
    next = data.next || null;
  }
  return out;
}

async function makeEvacuationGeometry(geometry, meters = 500) {
  const { buffer, cleanCoords } = await ensureTurf();

  // Turf takes Features or Geometries; we wrap as a Feature
  const feature = { type: 'Feature', geometry, properties: {} };

  // Buffer outward by 0.5 km. 'steps' controls roundness of corners.
  const buffered = buffer(feature, meters / 1000, { units: 'kilometers', steps: 16 });

  // Clean up any tiny artifacts/self-intersections
  const cleaned = cleanCoords(buffered);

  // If you want ONLY the outside ring (evac zone excluding the burnt area),
  // you could compute a ring with @turf/difference:
  //   const { default: difference } = await import('@turf/difference');
  //   const ring = difference(cleaned, feature);
  //   return (ring || cleaned).geometry;

  return cleaned.geometry;
}

function chooseDanger(areaHa) {
  const a = Number(areaHa || 0);
  if (a >= 1000) return 'extreme';
  if (a >= 300) return 'high';
  if (a >= 50) return 'moderate';
  return 'low';
}

// CHANGE: make async
async function toDisasterDoc(item) {
  const geometry = itemToGeoJSONGeometry(item);
  if (!geometry) return null;
  const lastupdate = coerceDate(item.lastupdate || item.last_update || item.updated || item.date || null);
  const areaHa = Number(item.area_ha || item.areaHa || item.area || 0);
  const country = item.country || item.ctry || COUNTRY;
  const name = item.name || item.fire_name || item.incident || null;
  const desc = `EFFIS Burnt Area${name ? ` — ${name}` : ''} (${country}) — ${areaHa ? areaHa.toFixed(1) : 'N/A'} ha`;

  // start/end heuristic if only lastupdate is present
  let startDate = item.startDate || (lastupdate ? new Date(lastupdate.getTime() - 6 * 3600e3) : new Date());
  let endDate = null;

  const dangerLevel = chooseDanger(areaHa);

  // NEW: compute a 500 m projected evacuation area
  let evacGeometry = null;
  try {
    evacGeometry = await makeEvacuationGeometry(geometry, 500);
  } catch (e) {
    console.warn('⚠️ Evacuation buffer failed, storing none:', e.message);
  }

  return {
    type: 'wildfire',
    description: desc,
    dangerLevel,
    areaOfEffect: geometry,
    startDate,
    endDate,
    historicalAreasOfEffect: [],
    // Store the buffered geometry as the first projected area (evacuation)
    projectedAreasOfEffect: evacGeometry ? [evacGeometry] : [],
    updatedAt: new Date(),
    source: 'effis_api',
    sourceId: String(item.id || item.pk || item.objectid || item.ba_id || `${country}-${lastupdate ? lastupdate.toISOString() : Date.now()}`)
  };
}

(async function main() {
  const url = buildUrl();
  console.log('🔗 EFFIS URL:', url);
  await mongoose.connect(MONGO_URI, { dbName: 'disasters' });
  console.log('✅ Mongo connected');

  try {
    if (CLEAR) {
        const del = await Disaster.deleteMany({}); // wipe the entire collection
        console.log(`🧹 Cleared ALL existing disasters: ${del.deletedCount}`);
        }


    const items = await fetchAll(url);
    console.log(`📥 Retrieved ${items.length} items from EFFIS`);

    const docs = [];
    let count = 0;
    for (const it of items) {
      if (PROVINCE && !provinceMatches(it.province || it.province_gr || it.nomosp || it.prefecture)) continue;
      if (Number(it.area_ha) < 200) continue;
      console.log(it.area_ha);
      if (count == 0) {
        it.startDate = FIRST_WILDFIRE_APPEARANCE;
      }
      if (count == 1) {
        it.startDate = SECOND_WILDFIRE_APPEARANCE;
      }
      count++;

      // CHANGE: await
      const d = await toDisasterDoc(it);
      if (d) docs.push(d);
    }

    if (!docs.length) {
      console.warn('⚠️ No geometries found to insert.');
    } else {
      // Upsert by (source, sourceId)
      let upserts = 0;
      for (const d of docs) {
        const res = await Disaster.updateOne(
        { source: d.source, sourceId: d.sourceId },
        { $set: d },
        { upsert: true }
        );
        // count approximate upserts (inserted or modified)
        if (res.upsertedCount || res.modifiedCount) upserts++;
      }
      console.log(`✅ Upserted ${upserts}/${docs.length} wildfire docs`);
    }
    } catch (e) {
        console.error('❌ Populate EFFIS error:', e);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
        console.log('🔌 Mongo disconnected');
    }
    })();
