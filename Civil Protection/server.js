#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import axios from 'axios';
import https from 'https';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { fileURLToPath } from 'url';

// ----------------- Paths & config -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT          = process.env.PORT || 3003;
const OUTPUTS_ROOT  = process.env.OUTPUTS_ROOT || path.resolve(__dirname, '../outputs');
const INSECURE_TLS  = String(process.env.INSECURE_TLS || '').toLowerCase() === 'true';

// FIWARE / Orion (fleet)
const ORION_BASE            = process.env.ORION_BASE || 'http://150.140.186.118:1026';
const ORION_URL             = ORION_BASE.replace(/\/$/, '') + '/v2/entities';
const FIWARE_SERVICE_PATH   = process.env.FIWARE_SERVICE_PATH || '/up1083865/thesis/Vehicles';
const FIWARE_SERVICE_TENANT = process.env.FIWARE_SERVICE_TENANT || undefined;
const BASE_ENTITY_ID_PREFIX = process.env.BASE_ENTITY_ID_PREFIX || 'urn:ngsi-ld:Vehicle:CIV';

// --- City partitioning ---
const CITY_CENTERS = {
  Athens:        [23.7348, 37.9755],
  Thessaloniki:  [22.9444, 40.6401],
  Patras:        [21.7346, 38.2466],
};
const CITY_RADIUS_KM = Number(process.env.CITY_RADIUS_KM || 90); // targets within 40km of city center


// Basic Auth for the whole app
const BASIC_USER       = (process.env.BASIC_USER || '').trim();
const BASIC_PASS       = process.env.BASIC_PASS;          // plain (optional)
const BASIC_PASS_HASH  = process.env.BASIC_PASS_HASH;     // bcrypt hash (optional)

// Road routing service (OSRM / Mapbox / Valhalla etc.)
const ROUTING_BASE = process.env.ROUTING_BASE || 'https://router.project-osrm.org'; // dev: OSRM demo


// ----------------- Axios agent (self-signed) -----------------
const httpsAgent = INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined;

// ----------------- Helpers -----------------
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(name => ({ name, full: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
    .filter(x => x.stat.isDirectory());
}
function pickLatestRunDir(root) {
  const dirs = listDirs(root);
  if (!dirs.length) return null;
  dirs.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return dirs[0].full;
}
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function redactedSummary(p) {
  // Return a safe, non-secret summary for debugging
  return {
    file: p.file,
    service: p.service,
    endpoint: p.endpoint,
    hasAuth: !!(p.auth && p.auth.token),
    hasCrypto: !!(p.crypto && p.crypto.secret),
    meta: p.meta || {}
  };
}
function normalizeEndpoint(cfg) {
  if (!cfg) return undefined;
  if (typeof cfg.endpoint === 'string') return cfg.endpoint;
  if (cfg.endpoint && typeof cfg.endpoint.url === 'string') return cfg.endpoint.url;
  return undefined;
}

function classifyService(cfg) {
  // Pull possible hints
  const tag = String(
    cfg?.meta?.service ??
    cfg?.semantics?.entityType ??
    cfg?.dataset ??
    ''
  ).toLowerCase();

  const ep = String(normalizeEndpoint(cfg) || '').toLowerCase();

  // Order matters: 'ameaclub' must match before 'amea'
  if (/natural|disaster/.test(tag) || /natural|disaster/.test(ep)) return 'naturaldisaster';
  if (/ameaclub/.test(tag) || /ameaclub/.test(ep)) return 'ameaclub';
  if (/\bamea\b/.test(tag) || /\bamea\b/.test(ep)) return 'amea';

  return 'other';
}

// OSRM duration matrix between origin(s) and destination(s)
async function osrmTable(origins, destinations) {
  if (!Array.isArray(origins) || !origins.length || !Array.isArray(destinations) || !destinations.length) return null;

  const coords = [...origins, ...destinations];
  const locStr = coords.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');

  const sources       = origins.map((_, i) => i).join(';');                 // 0..M-1
  const destStart     = origins.length;
  const destinationsQ = destinations.map((_, i) => i + destStart).join(';');// M..M+N-1

  const url = `${ROUTING_BASE}/table/v1/driving/${locStr}?annotations=duration&sources=${sources}&destinations=${destinationsQ}`;
  try {
    const r = await axios.get(encodeURI(url), { timeout: 15000 });
    const { durations } = r.data || {};
    if (!durations || !durations.length) return null;
    return { durations };
  } catch (e) {
    console.warn('OSRM table failed:', e.response?.status || e.message);
    return null;
  }
}


async function osrmRoute(coords) {
  // coords: [[lon,lat], [lon,lat], ...] in the *final visiting order*
  if (!Array.isArray(coords) || coords.length < 2) return null;

  // OSRM format: "lon,lat;lon,lat;..."
  const pathStr = coords.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
  const url = `${ROUTING_BASE}/route/v1/driving/${pathStr}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`;

  try {
    const r = await axios.get(encodeURI(url), { timeout: 15000 });
    const route = r.data?.routes?.[0];
    if (!route?.geometry) return null;
    return {
      geometry: route.geometry,                            // GeoJSON LineString
      distanceKm: (route.distance || 0) / 1000,
      durationMin: (route.duration || 0) / 60
    };
  } catch (e) {
    console.warn('OSRM route failed:', e.response?.status || e.message);
    return null;
  }
}

// Deterministic "random" color from a key (vehicle id/plate)
function colorForKey(key = '') {
  // 32-bit hash with golden-ratio multiplier → stable hue 0..359
  let h = 0 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 2654435761 + key.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 78%, 45%)`; // vivid, readable
}


function toPointFeature(lon, lat, props = {}) {
  const L = Number(lat), G = Number(lon);
  if (!Number.isFinite(L) || !Number.isFinite(G)) return null;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [G, L] }, properties: props };
}
// AES-256 key from secret (accepts base64(32), hex(64), or passphrase)
function parseAes256Key(secret) {
  if (!secret) return null;
  const v = String(secret).trim();
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {}
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  return crypto.scryptSync(v, 'ids-client-derive', 32);
}
function getAes256Key(raw) {
  const v = (raw || '').trim();
  // base64 32B?
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {/* ignore */}
  // hex 32B?
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  // passphrase -> scrypt (SAME SALT)
  return crypto.scryptSync(v, Buffer.from('dataspace-api-static-salt', 'utf8'), 32);
}

function decryptGCM_envelopeObj(payload, KEY) {
  const { iv, tag, ciphertext } = payload || {};
  if (!iv || !tag || !ciphertext) throw new Error('Encrypted payload missing iv/tag/ciphertext');
  const ivB  = Buffer.from(iv, 'base64');
  const tagB = Buffer.from(tag, 'base64');
  const ctB  = Buffer.from(ciphertext, 'base64');
  const dec  = crypto.createDecipheriv('aes-256-gcm', KEY, ivB);
  dec.setAuthTag(tagB);
  const pt = Buffer.concat([dec.update(ctB), dec.final()]);
  return pt.toString('utf8');
}
function fiwareHeaders() {
  const h = { 'Fiware-ServicePath': FIWARE_SERVICE_PATH };
  if (FIWARE_SERVICE_TENANT) h['Fiware-Service'] = FIWARE_SERVICE_TENANT;
  return h;
}

// ----------------- Load provider configs from outputs -----------------
function loadProviderConfigs(outputsRoot) {
  const latest = pickLatestRunDir(outputsRoot);
  if (!latest) return { dir: null, providers: [] };

  // prefer *.raw.json per base; fallback *.json
  const files = fs.readdirSync(latest)
    .filter(f => f.endsWith('.raw.json') || f.endsWith('.json'))
    .map(f => path.join(latest, f));

  const chosen = new Map();
  for (const full of files) {
    const base = path.basename(full).replace(/\.raw\.json$|\.json$/i, '');
    const isRaw = full.endsWith('.raw.json');
    const prev = chosen.get(base);
    if (!prev || (isRaw && !prev.isRaw)) chosen.set(base, { full, isRaw });
  }

  const providers = [];
  for (const { full } of chosen.values()) {
    
    const cfg = readJsonSafe(full);
    if (!cfg || typeof cfg !== 'object') continue;
    // must look like the secured config artifact we saved
    // if (!cfg.endpoint) continue;
    const endpoint = normalizeEndpoint(cfg);

    providers.push({
    file: full,
    service: classifyService(cfg),
    endpoint,                      // <- always a string now (or undefined)
    auth: cfg.auth || null,
    crypto: cfg.crypto || null,
    meta: cfg.meta || {},
    semantics: cfg.semantics || null
    });

  }
  return { dir: latest, providers };
}

// initial load
let { dir: RUN_DIR, providers: PROVIDERS } = loadProviderConfigs(OUTPUTS_ROOT);

// ----------------- Basic Auth middleware -----------------
async function basicAuth(req, res, next) {
  const unauthorized = () => {
    res.set('WWW-Authenticate', 'Basic realm="civil-map"');
    return res.status(401).send('Authentication required');
  };

  if (!BASIC_USER || (!BASIC_PASS && !BASIC_PASS_HASH)) {
    console.error('Basic auth not configured (set BASIC_USER and BASIC_PASS or BASIC_PASS_HASH)');
    return unauthorized();
  }

  const hdr = req.headers['authorization'] || '';
  if (!hdr.startsWith('Basic ')) return unauthorized();

  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  // allow ":" in password
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';

  if (user !== BASIC_USER) return unauthorized();
  if (BASIC_PASS_HASH) {
    try {
      const ok = await bcrypt.compare(pass, BASIC_PASS_HASH);
      if (!ok) return unauthorized();
    } catch { return unauthorized(); }
  } else {
    if (pass !== (BASIC_PASS || '')) return unauthorized();
  }
  return next();
}

// ----------------- App -----------------
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      "style-src":  ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      "img-src":    ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
      "connect-src": ["'self'", "https://unpkg.com"]
    }
  }
}));

// health (no auth)
app.get('/healthz', (_req, res) => res.json({
  ok: true, outputsRoot: OUTPUTS_ROOT, latestRunDir: RUN_DIR, providersLoaded: PROVIDERS.length
}));

// everything else behind Basic Auth
app.use(basicAuth);
app.use(express.json());

// hot-reload providers (re-scan outputs)
app.post('/api/reload', (req, res) => {
  ({ dir: RUN_DIR, providers: PROVIDERS } = loadProviderConfigs(OUTPUTS_ROOT));
  res.json({ ok: true, latestRunDir: RUN_DIR, providers: PROVIDERS.map(redactedSummary) });
});

// list providers (redacted summary)
app.get('/api/providers', (_req, res) => {
  res.json({
    latestRunDir: RUN_DIR,
    count: PROVIDERS.length,
    providers: PROVIDERS.map(redactedSummary)
  });
});

function extractCoords(d) {
  // ameaclub-style
  let lat = d.latitude ?? d.lat ?? d.location?.lat ?? d.location?.latitude;
  let lon = d.longitude ?? d.lng ?? d.location?.lon ?? d.location?.longitude;

  // mhtroo-style: GeoJSON Point { loc: { type:'Point', coordinates:[lon,lat] } }
  if ((!Number.isFinite(lat) || !Number.isFinite(lon))
      && d.loc?.type === 'Point'
      && Array.isArray(d.loc.coordinates)
      && d.loc.coordinates.length === 2) {
    [lon, lat] = d.loc.coordinates;
  }
  return { lat: Number(lat), lon: Number(lon) };
}

function prettyName(d) {
  const clean = (s) => (typeof s === 'string' && !s.includes(':') ? s : null);
  const n = clean(d.name);
  const s = clean(d.surname);
  if (n && s) return `${n} ${s}`;
  if (n) return n;
  if (d.region?.municipality) return `AMEA — ${d.region.municipality}`;
  if (d._id) return `AMEA ${String(d._id).slice(-6)}`;
  return 'AMEA';
}

app.get('/api/amea', async (_req, res) => {
  const sources = PROVIDERS.filter(p =>
    ['amea','ameaclub'].includes(p.service) ||
    String(p.endpoint||'').toLowerCase().includes('/api/ids/data')
  );
  if (sources.length === 0) {
    return res.status(404).json({ error: 'no_amea_sources' });
  }

  const rows = [];
  await Promise.all(sources.map(async (p) => {
    try {
      const headers = {};
      if (p.auth?.scheme && p.auth?.token) headers.Authorization = `${p.auth.scheme} ${p.auth.token}`;
      const r = await axios.get(p.endpoint, { headers, httpsAgent, timeout: 20000 });
      let body = r.data;

      if (body && body.iv && body.tag && body.ciphertext && p.crypto?.secret) {
        const KEY = getAes256Key(p.crypto.secret);
        const plaintext = decryptGCM_envelopeObj(body, KEY);
        try { body = JSON.parse(plaintext); } catch { body = plaintext; }
      }

      const arr = Array.isArray(body) ? body : (body?.items || body?.results || body?.data || []);
      if (Array.isArray(arr)) rows.push(...arr);
    } catch (e) {
      console.warn(`AMEA fetch failed from ${p.endpoint}:`, e.response?.status || e.message);
    }
  }));

  const features = [];
  for (const d of rows) {
    const { lat, lon } = extractCoords(d);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const email = typeof d.email === 'string' ? d.email : d.email?.value;
    const phone = d.phone ?? d.phoneNumber?.value ?? d.landNumber?.value;

    const f = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: prettyName(d),
        disabilityPct: d.disabilityPct ?? d.disability_percent ?? undefined,
        phone,
        email
      }
    };
    features.push(f);
  }

  res.json({ type: 'FeatureCollection', features });
});


// --- helpers for polygon -> centroid ---
function centroidOfGeometry(geom) {
  if (!geom || !geom.type || !geom.coordinates) return null;

  // Shoelace centroid (outer ring only) but fall back to simple average if needed
  function ringCentroid(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j] || [];
      const [x1, y1] = ring[i] || [];
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      const f = (x0 * y1) - (x1 * y0);
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    if (a === 0) {
      // fallback: simple average
      let sx = 0, sy = 0, n = 0;
      for (const [x, y] of ring) {
        if (Number.isFinite(x) && Number.isFinite(y)) { sx += x; sy += y; n++; }
      }
      return n ? { lon: sx / n, lat: sy / n } : null;
    }
    a *= 0.5;
    return { lon: cx / (6 * a), lat: cy / (6 * a) };
  }

  if (geom.type === 'Polygon') {
    const ring = geom.coordinates?.[0];
    return ringCentroid(ring);
  }
  if (geom.type === 'MultiPolygon') {
    const firstRing = geom.coordinates?.[0]?.[0];
    return ringCentroid(firstRing);
  }
  return null;
}

function parseDateSafe(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

function isActive(props) {
  const now = Date.now();
  const start = parseDateSafe(props.startDate || props.startedAt || props.timestamp);
  const end   = parseDateSafe(props.endDate   || props.endedAt);
  if (end && end.getTime() <= now) return false;     // ended in the past
  if (start && start.getTime() >  now) return false; // starts in the future
  return true; // no end or end in future (and not future-starting)
}



app.get('/api/disasters', async (_req, res) => {
  const sources = PROVIDERS.filter(p =>
    p.service === 'naturaldisaster' ||
    String(p.endpoint || '').toLowerCase().includes('natural')
  );

  const features = [];

  await Promise.all(sources.map(async (p) => {
    try {
      const r = await axios.get(p.endpoint, { httpsAgent, timeout: 20000 });
      let body = r.data;

      // If provider already serves FeatureCollection, reuse it (filter active)
      if (body && body.type === 'FeatureCollection' && Array.isArray(body.features)) {
        for (const f of body.features) {
          if (!f || !f.geometry) continue;
          const props = f.properties || {};
          if (!isActive(props)) continue; // ✅ keep only active
          const { historicalAreasOfEffect, projectedAreasOfEffect, ...clean } = props;
          features.push({ type: 'Feature', geometry: f.geometry, properties: clean });
        }
        return;
      }

      // Otherwise treat it as an array of docs (filter active)
      const arr = Array.isArray(body) ? body : (body?.items || body?.results || body?.data || []);
      for (const d of arr) {
        const geom = d.areaOfEffect || d.geometry;
        if (!geom || !geom.type || !geom.coordinates) continue;

        // Check activity off the raw doc to be robust
        if (!isActive({ startDate: d.startDate ?? d.startedAt ?? d.timestamp,
                        endDate:   d.endDate   ?? d.endedAt })) continue; // ✅ only active

        const {
          _id, __v, areaOfEffect,
          historicalAreasOfEffect, projectedAreasOfEffect,
          ...props
        } = d;

        features.push({
          type: 'Feature',
          geometry: geom,
          properties: {
            id: String(_id ?? d.id ?? ''),
            ...props,
            // counts (optional)
            historicalCount: Array.isArray(historicalAreasOfEffect) ? historicalAreasOfEffect.length : undefined,
            projectedCount:  Array.isArray(projectedAreasOfEffect)  ? projectedAreasOfEffect.length  : undefined,
          }
        });
      }
    } catch (e) {
      console.warn(`disasters from ${p.endpoint} failed:`, e.response?.status || e.message);
    }
  }));

  res.json({ type: 'FeatureCollection', features });
});


// ---- geometry helpers (point-in-polygon) ----
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygon([x, y], polygon) {
  const rings = polygon.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (!pointInRing([x, y], rings[0])) return false;       // outer
  for (let r = 1; r < rings.length; r++) {                // holes
    if (pointInRing([x, y], rings[r])) return false;
  }
  return true;
}
function pointInMultiPolygon([x, y], multiPolygon) {
  return multiPolygon.coordinates.some(polyCoords =>
    pointInPolygon([x, y], { type: 'Polygon', coordinates: polyCoords })
  );
}
function pointInGeom([x, y], geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon([x, y], geom);
  if (geom.type === 'MultiPolygon') return pointInMultiPolygon([x, y], geom);
  return false;
}

// ---- distance + routing helpers ----
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}


function nearestCityForCoord([lon, lat]) {
  let bestCity = null, bestD = Infinity;
  for (const [city, center] of Object.entries(CITY_CENTERS)) {
    const d = haversineKm(center, [lon, lat]); // haversineKm expects [lon,lat]
    if (d < bestD) { bestD = d; bestCity = city; }
  }
  return bestD <= CITY_RADIUS_KM ? bestCity : null;
}


// nearest-neighbor path starting at startCoord over array of stops [{id, name, coord:[lon,lat]}]
function nearestNeighborRoute(startCoord, stops) {
  const remaining = stops.slice();
  const order = [];
  let curr = startCoord;

  while (remaining.length) {
    let bestIdx = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(curr, remaining[i].coord);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    const nxt = remaining.splice(bestIdx, 1)[0];
    order.push(nxt);
    curr = nxt.coord;
  }
  return order;
}

// ---- reuse your existing fetching logic as functions ----
async function loadAmeaFeatures() {
  const sources = PROVIDERS.filter(p =>
    ['amea','ameaclub'].includes(p.service) ||
    String(p.endpoint||'').toLowerCase().includes('/api/ids/data')
  );
  const rows = [];
  await Promise.all(sources.map(async (p) => {
    try {
      const headers = {};
      if (p.auth?.scheme && p.auth?.token) headers.Authorization = `${p.auth.scheme} ${p.auth.token}`;
      const r = await axios.get(p.endpoint, { headers, httpsAgent, timeout: 20000 });
      let body = r.data;
      if (body && body.iv && body.tag && body.ciphertext && p.crypto?.secret) {
        const KEY = getAes256Key(p.crypto.secret);
        const plaintext = decryptGCM_envelopeObj(body, KEY);
        try { body = JSON.parse(plaintext); } catch { body = plaintext; }
      }
      const arr = Array.isArray(body) ? body : (body?.items || body?.results || body?.data || []);
      if (Array.isArray(arr)) rows.push(...arr);
    } catch {}
  }));
  const features = [];
  for (const d of rows) {
    let lat = d.latitude ?? d.lat ?? d.location?.lat ?? d.location?.latitude;
    let lon = d.longitude ?? d.lng ?? d.location?.lon ?? d.location?.longitude;
    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) &&
        d.loc?.type === 'Point' && Array.isArray(d.loc.coordinates) && d.loc.coordinates.length === 2) {
      [lon, lat] = d.loc.coordinates;
    }
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const email = typeof d.email === 'string' ? d.email : d.email?.value;
    const phone = d.phone ?? d.phoneNumber?.value ?? d.landNumber?.value;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: String(d._id ?? d.id ?? ''),
        name: (typeof d.name === 'string' && !d.name.includes(':')) ? d.name : (d.region?.municipality ? `AMEA — ${d.region.municipality}` : 'AMEA'),
        disabilityPct: d.disabilityPct ?? d.disability_percent ?? undefined,
        phone, email
      }
    });
  }
  return features;
}

async function loadFleetFeatures() {
  const params = { type: 'Vehicle', limit: 1000, options: 'keyValues' };
  const r = await axios.get(ORION_URL, { params, headers: fiwareHeaders(), timeout: 15000 });
  let entities = r.data || [];
  if (BASE_ENTITY_ID_PREFIX) entities = entities.filter(e => String(e.id || '').startsWith(BASE_ENTITY_ID_PREFIX));
  const features = [];
  for (const e of entities) {
    const coords = Array.isArray(e?.location?.coordinates) ? e.location.coordinates : null;
    if (!coords || coords.length !== 2) continue;
    const totalSeats    = Number(e.totalSeats ?? 0);
    const occupiedSeats = Number(e.occupiedSeats ?? e.crew ?? 0);
    const availableSeats = Math.max(0, totalSeats - occupiedSeats);
    console.log("type",e.type)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        id: e.id,
        license_plate: e.license_plate ?? '-',
        type: e.vehicleType ?? 'unknown',
        totalSeats,
        occupiedSeats,
        availableSeats
      }
    });
  }
  console.log("features",features.length)
  console.log(features[0])
  return features;
}

// function parseDateSafe(v) {
//   if (!v) return null;
//   const t = Date.parse(v);
//   return Number.isFinite(t) ? new Date(t) : null;
// }
// function isActive(props) {
//   const now = Date.now();
//   const start = parseDateSafe(props.startDate || props.startedAt || props.timestamp);
//   const end   = parseDateSafe(props.endDate   || props.endedAt);
//   if (end && end.getTime() <= now) return false;
//   if (start && start.getTime() >  now) return false;
//   return true;
// }
async function loadActiveDisasterGeometries() {
  const sources = PROVIDERS.filter(p =>
    p.service === 'naturaldisaster' ||
    String(p.endpoint || '').toLowerCase().includes('natural')
  );
  const geoms = [];
  await Promise.all(sources.map(async (p) => {
    try {
      const r = await axios.get(p.endpoint, { httpsAgent, timeout: 20000 });
      const body = r.data;
      if (body && body.type === 'FeatureCollection' && Array.isArray(body.features)) {
        for (const f of body.features) {
          if (!f || !f.geometry) continue;
          if (!isActive(f.properties || {})) continue;
          if (/Polygon/i.test(f.geometry.type)) geoms.push(f.geometry);
        }
        return;
      }
      const arr = Array.isArray(body) ? body : (body?.items || body?.results || body?.data || []);
      for (const d of arr) {
        if (!isActive({ startDate: d.startDate ?? d.startedAt ?? d.timestamp,
                        endDate:   d.endDate   ?? d.endedAt })) continue;
        const g = d.areaOfEffect || d.geometry;
        if (g && /Polygon/i.test(g.type)) geoms.push(g);
      }
    } catch {}
  }));
  return geoms;
}

function buildGmapsDirUrl(orderedCoords) {
  // orderedCoords is [[lon,lat], [lon,lat], ...] where 0 = start, last = final stop(s)
  if (!Array.isArray(orderedCoords) || orderedCoords.length < 2) return null;

  const toLatLng = ([lon, lat]) => `${lat},${lon}`;

  const origin = toLatLng(orderedCoords[0]);
  const destination = toLatLng(orderedCoords[orderedCoords.length - 1]);

  const waypointsArr = orderedCoords.slice(1, -1).map(toLatLng); // everything between
  const waypoints = waypointsArr.join('|');

  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (waypointsArr.length) url.searchParams.set('waypoints', waypoints);
  url.searchParams.set('travelmode', 'driving');
  return url.toString();
}


// ---- planner endpoint (OSRM-backed) ----
app.post('/api/plan-routes', async (_req, res) => {
  try {
    const time1 = Date.now();
    const include = Array.isArray(_req.body?.include) ? _req.body.include.map(String) : [];
    const [amea, fleet, geoms] = await Promise.all([
      loadAmeaFeatures(), 
      loadFleetFeatures(), 
      loadActiveDisasterGeometries()
    ]);

    if (!fleet.length || !geoms.length) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { vehicles: fleet.length, targets: 0, activeDisasters: geoms.length }
      });
    }

    // 1) Targets = AMEA inside any active disaster polygon
    const targets = [];
    for (const f of amea) {
      const c = f.geometry?.coordinates;
      if (!Array.isArray(c) || c.length !== 2) continue;
      if (geoms.some(g => pointInGeom(c, g))) {
        targets.push({
          id: f.properties?.id || '',
          name: f.properties?.name || 'AMEA',
          coord: c
        });
      }
    }

    if (!targets.length) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: { vehicles: fleet.length, targets: 0, activeDisasters: geoms.length }
      });
    }
    console.log("Targets: " + targets.length);
    for(let i = 0; i < targets.length; i++) {
      console.log(targets[i].id + " " + targets[i].name + " " + targets[i].coord);
    }
    
    const vehiclesAll = fleet
      .map(v => ({
        id: v.properties.id,
        type: v.properties.type,
        plate: v.properties.license_plate,
        start: v.geometry.coordinates,                 // [lon, lat]
        seatsLeft: Number(v.properties.availableSeats ?? 0),
        city: nearestCityForCoord(v.geometry.coordinates),
        picks: []
      }))
      .filter(v => v.seatsLeft > 0)
      .filter(v => include.length ? include.includes(String(v.id)) : true); // <- filter here

    const totalFree = vehiclesAll.reduce((s, v) => s + v.seatsLeft, 0);
    if (!totalFree) {
      return res.json({
        type: 'FeatureCollection',
        features: [],
        meta: {
          vehicles: fleet.length,
          targets: targets.length,
          activeDisasters: geoms.length,
          reason: include.length ? 'no_capacity_in_selected' : 'no_capacity'
        }
      });
    }
    console.log("2a) Vehicles: " + vehiclesAll.length);
    // 2a) Group vehicles and targets by city (Athens/Thessaloniki/Patras)
    const cityNames = Object.keys(CITY_CENTERS);
    const cityVehicles = Object.fromEntries(cityNames.map(c => [c, []]));
    for (const v of vehiclesAll) cityVehicles[v.city].push(v);

    const cityTargets = Object.fromEntries(cityNames.map(c => [c, []]));
    for (const t of targets) {
    const c = nearestCityForCoord(t.coord);
    cityTargets[c].push(t);
    }

    // 2b) Per-city greedy assignment using OSRM durations (smaller matrices)
    for (const city of cityNames) {
    const vList = cityVehicles[city];
    const tList = cityTargets[city];
    if (!vList?.length || !tList?.length) continue;

    const table = await osrmTable(
        vList.map(v => v.start),
        tList.map(t => t.coord)
    );
    const durations = table?.durations; // shape: vList x tList

    const unassigned = new Set(tList.map((_, i) => i));
    while (unassigned.size && vList.some(v => v.seatsLeft > 0)) {
        let bestVI = -1, bestTI = -1, bestScore = Infinity;
        for (let vi = 0; vi < vList.length; vi++) {
        if (vList[vi].seatsLeft <= 0) continue;
        for (const ti of unassigned) {
            let score;
            if (durations && durations[vi] && Number.isFinite(durations[vi][ti])) {
            score = durations[vi][ti]; // seconds
            } else {
            score = haversineKm(vList[vi].start, tList[ti].coord); // fallback
            }
            if (score < bestScore) { bestScore = score; bestVI = vi; bestTI = ti; }
        }
        }
        if (bestVI === -1) break;
        vList[bestVI].picks.push(tList[bestTI]);
        vList[bestVI].seatsLeft -= 1;
        unassigned.delete(bestTI);
    }
    }
    console.log(`Greedy planning (per-city nearest-center) took ${Date.now() - time1} ms`);


    // 3) Build a route per vehicle using nearest-neighbor order, then OSRM route
    const features = [];
    for (const v of vehiclesAll) {
      if (!v.picks.length) continue;

      const order = nearestNeighborRoute(v.start, v.picks);         // returns [{coord, name, ...}, ...]
      const orderedCoords = [v.start, ...order.map(o => o.coord)];  // [[lon,lat],...]

      // Try OSRM first
      let geometry, distanceKm, durationMin;
      const routed = await osrmRoute(orderedCoords);
      if (routed) {
        geometry = routed.geometry;             // GeoJSON LineString
        distanceKm = Number(routed.distanceKm.toFixed(2));
        durationMin = Number(routed.durationMin.toFixed(1));
      } else {
        // Fallback: straight lines
        geometry = { type: 'LineString', coordinates: orderedCoords };
        let totalKm = 0;
        for (let i = 1; i < orderedCoords.length; i++) {
          totalKm += haversineKm(orderedCoords[i - 1], orderedCoords[i]);
        }
        distanceKm = Number(totalKm.toFixed(2));
        durationMin = undefined;
      }
      const directionsUrl = buildGmapsDirUrl(orderedCoords);
      console.log(`Directions for ${v.id}: ${directionsUrl}`);

      // Route feature
      features.push({
        type: 'Feature',
        geometry,
        properties: {
          kind: 'route',
          type: v.type,
          vehicleId: v.id,
          license_plate: v.plate,
          city: v.city,
          assigned: order.length,
          capacityUsed: order.length,
          capacityTotal: v.seatsLeft,
          distanceKm,
          durationMin
        }
      });

      // Numbered pickup points
      order.forEach((o, idx) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: o.coord },
          properties: {
            kind: 'pickup',
            type: v.type,
            vehicleId: v.id,
            license_plate: v.plate,
            city: v.city,
            seq: idx + 1,
            name: o.name
          }
        });
      });
    }

    const time2 = Date.now();
    console.log(`plan-routes: ${time2 - time1} ms, ${features.length} routes`);
    return res.json({
      type: 'FeatureCollection',
      features,
      meta: { vehicles: fleet.length, targets: targets.length, activeDisasters: geoms.length }
    });
  } catch (e) {
    console.error('plan-routes error', e);
    res.status(500).json({ error: 'plan_failed', detail: String(e) });
  }
});


// --- Fleet (FIWARE Orion) -> GeoJSON
app.get('/api/fleet', async (_req, res) => {
  try {
    const params = { type: 'Vehicle', limit: 1000, options: 'keyValues' };
    const r = await axios.get(ORION_URL, { params, headers: fiwareHeaders(), timeout: 15000 });
    let entities = r.data || [];
    if (BASE_ENTITY_ID_PREFIX) entities = entities.filter(e => String(e.id || '').startsWith(BASE_ENTITY_ID_PREFIX));

    const features = [];
    for (const e of entities) {
      const coords = Array.isArray(e?.location?.coordinates) ? e.location.coordinates : null;
      if (!coords || coords.length !== 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coords },
        properties: {
          id: e.id,
          type: e.vehicleType ?? 'unknown',
          license_plate: e.license_plate ?? '-',
          status: e.status ?? '-',
          speed: e.speed ?? 0,
          lastUpdated: e.lastUpdated ?? '-'
        }
      });
    }
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json({ error: 'orion_fetch_failed', detail: err.response?.data || String(err) });
  }
});

// static app (Leaflet) after auth
app.use(express.static(path.join(__dirname, 'public')));

// root -> map
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------- Start -----------------
ensureDir(path.join(__dirname, 'public'));
console.log(`📦 outputs root: ${OUTPUTS_ROOT}`);
console.log(`📂 latest run:   ${RUN_DIR || '(none found)'}`);
console.log(`🧩 providers:    ${PROVIDERS.length}`);

app.listen(PORT, () => {
  console.log(`✅ map server on http://localhost:${PORT}`);
});
