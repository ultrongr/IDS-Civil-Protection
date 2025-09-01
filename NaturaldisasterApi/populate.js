// populate.js — scenario-driven + historic bias
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker');
const Disaster = require('./models/Disaster');

// your utils (we'll also pass an optional "kind" to randomShapePolygon if you add it)
const {
  randomPointInGreece,
  randomShapePolygon,  // (center, radiusKm, kind?) -> GeoJSON Polygon/MultiPolygon
  scaleGeometryAround  // (center, geometry, factor) -> scaled geometry
} = require('./utils/geo');

// ---------- CLI/ENV ----------
const argv = process.argv.slice(2);
const firstNum = argv.find(a => !a.startsWith('--'));
const COUNT = Number(firstNum || process.env.SEED_COUNT || 60);

function getOpt(name, fallback) {
  const key = `--${name}=`;
  const hit = argv.find(a => a.startsWith(key));
  return hit ? hit.slice(key.length) : (process.env[name.toUpperCase()] ?? fallback);
}

const SCENARIO_FILE = getOpt('scenario', process.env.SCENARIO_FILE || "scenario.json");
const ACTIVE_RATIO  = Number(getOpt('active-ratio', process.env.ACTIVE_RATIO || '0.2')); // 20% active by default
const MONGO_URI     = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/disasters';

// ---------- Defaults & helpers ----------
const DISASTER_TYPES = [
  { type: 'wildfire',   min: 4,  max: 25 },
  { type: 'flood',      min: 2,  max: 14 },
  { type: 'earthquake', min: 8,  max: 50 },
  { type: 'storm',      min: 12, max: 70 }
];
const DANGER_LEVELS = ['low', 'moderate', 'high', 'extreme'];

// quick centroid for Polygon/MultiPolygon (outer ring only)
function centroidOf(geom) {
  if (!geom || !geom.type || !geom.coordinates) return null;

  function ringCentroid(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      const f = (x0 * y1) - (x1 * y0);
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    if (a === 0) return null;
    a *= 0.5;
    return [cx / (6 * a), cy / (6 * a)];
  }

  if (geom.type === 'Polygon') {
    return ringCentroid(geom.coordinates?.[0]) || null;
  }
  if (geom.type === 'MultiPolygon') {
    // take first polygon's outer ring
    return ringCentroid(geom.coordinates?.[0]?.[0]) || null;
  }
  return null;
}

function pickType(explicit) {
  if (explicit) return explicit;
  const base = faker.helpers.arrayElement(DISASTER_TYPES);
  return base.type;
}

function radiusFor(type, override) {
  if (override) return Number(override);
  const base = DISASTER_TYPES.find(d => d.type === type) || DISASTER_TYPES[0];
  return faker.number.float({ min: base.min, max: base.max });
}

function makeGeom({ center, radiusKm, shape, geometry }) {
  if (geometry && geometry.type && geometry.coordinates) {
    return geometry; // explicit
  }
  const c = Array.isArray(center) && center.length === 2 ? center : randomPointInGreece();
  const r = Number(radiusKm || 10);
  // If you extend utils/randomShapePolygon to accept a third "kind" ('circle'|'ellipse'|'blob'|'multi'),
  // this will honor shape; otherwise it’ll just ignore it and make a random shape.
  return randomShapePolygon(c, r, shape);
}

function mkHistorical(center, geom, cfg) {
  const steps = Math.max(0, Number(cfg?.steps ?? 2));
  const factor = Number(cfg?.factor ?? 0.8); // shrink per step
  const out = [];
  for (let i = 1; i <= steps; i++) {
    out.push(scaleGeometryAround(center, geom, Math.pow(factor, i)));
  }
  return out;
}
function mkProjected(center, geom, cfg) {
  const steps = Math.max(0, Number(cfg?.steps ?? 1));
  const factor = Number(cfg?.factor ?? 1.25); // grow per step
  const out = [];
  for (let i = 1; i <= steps; i++) {
    out.push(scaleGeometryAround(center, geom, Math.pow(factor, i)));
  }
  return out;
}

function parseWhen(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim().toUpperCase();
  if (s === 'NOW') return new Date();
  const m = s.match(/^NOW([+-])(\d+)([HMD])$/); // e.g. NOW-3H, NOW+2D
  if (m) {
    const [, sign, numStr, unit] = m;
    const num = Number(numStr);
    const mult = unit === 'H' ? 3600e3 : unit === 'D' ? 24*3600e3 : 60e3; // H/D/M(in)
    const delta = (sign === '-' ? -1 : 1) * num * mult;
    return new Date(Date.now() + delta);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}


// ---------- Scenario support ----------
function loadScenario(fp) {
  if (!fp) return null;
  const full = path.resolve(fp);
  const raw = fs.readFileSync(full, 'utf8');
  const j = JSON.parse(raw);
  if (!j || !Array.isArray(j.events)) {
    throw new Error('Scenario file must have an "events" array.');
  }
  return j;
}

// Build one doc from scenario event + defaults
function fromScenario(evt, defaults = {}) {
  const type = pickType(evt.type || defaults.type);
  const radiusKm = radiusFor(type, evt.radiusKm || defaults.radiusKm);
  const geom = makeGeom({
    center: evt.center || defaults.center,
    radiusKm,
    shape: evt.shape || defaults.shape,
    geometry: evt.geometry
  });

  const center = evt.center || centroidOf(geom) || randomPointInGreece();

  // timings
  const start = parseWhen(evt.start ?? evt.startDate ?? defaults.start) || new Date(Date.now() - 6*3600e3);
  let end = parseWhen(evt.end ?? evt.endDate);
  if (!end && evt.durationHours) end = new Date(start.getTime() + Number(evt.durationHours) * 3600e3);


  // tracks
  const histCfg = evt.historical ?? defaults.historical ?? { steps: 3, factor: 0.8 };
  const projCfg = evt.projected  ?? defaults.projected  ?? { steps: 1, factor: 1.25 };

  return {
    type,
    description: evt.description || defaults.description || faker.lorem.sentence({ min: 8, max: 18 }),
    dangerLevel: (evt.dangerLevel || defaults.dangerLevel || faker.helpers.arrayElement(DANGER_LEVELS)),
    areaOfEffect: geom,
    startDate: start,
    endDate: end ?? null,
    historicalAreasOfEffect: mkHistorical(center, geom, histCfg),
    projectedAreasOfEffect: mkProjected(center, geom, projCfg),
    updatedAt: new Date(),
    source: evt.source || defaults.source || 'scenario'
  };
}

// ---------- Random doc (historic-biased) ----------
function randomDoc() {
  const type = pickType();
  const radiusKm = radiusFor(type);
  const center = randomPointInGreece();
  const geom = randomShapePolygon(center, radiusKm);

  // Active vs historic
  const active = Math.random() < ACTIVE_RATIO;

  // Time windows you can tweak
  const now = Date.now();
  // historic: start within last 30 days, ended 1–72h after start (and before now)
  // active: start within last 48h, end null or small future
  let start, end;
  if (active) {
    start = new Date(now - faker.number.int({ min: 1, max: 48 }) * 3600 * 1000);
    end = Math.random() < 0.3 ? new Date(now + faker.number.int({ min: 1, max: 12 }) * 3600 * 1000) : null;
  } else {
    start = new Date(now - faker.number.int({ min: 2, max: 30 * 24 }) * 3600 * 1000);
    const durH = faker.number.int({ min: 1, max: 72 });
    end = new Date(start.getTime() + durH * 3600 * 1000);
    if (end > now) end = new Date(now - faker.number.int({ min: 1, max: 6 }) * 3600 * 1000);
  }

  // Tracks
  const historical = mkHistorical(center, geom, { steps: faker.number.int({ min: 1, max: 3 }), factor: 0.8 });
  const projected  = mkProjected(center, geom,  { steps: active ? faker.number.int({ min: 0, max: 2 }) : 0, factor: 1.25 });

  return {
    type,
    description: faker.lorem.sentence({ min: 10, max: 24 }),
    dangerLevel: faker.helpers.arrayElement(DANGER_LEVELS),
    areaOfEffect: geom,
    startDate: start,
    endDate: end,
    historicalAreasOfEffect: historical,
    projectedAreasOfEffect: projected,
    updatedAt: new Date(),
    source: 'faker'
  };
}

// ---------- Main ----------
(async function main() {
  await mongoose.connect(MONGO_URI, { dbName: 'disasters' });
  console.log('Mongo connected');

  try {
    console.log('Clearing existing disasters...');
    const del = await Disaster.deleteMany({});
    console.log(`Deleted: ${del.deletedCount}`);

    let created = [];

    const scenario = SCENARIO_FILE ? loadScenario(SCENARIO_FILE) : null;
    if (scenario) {
      const defs = scenario.defaults || {};
      const fromEvents = scenario.events.map(evt => fromScenario(evt, defs));
      created.push(...fromEvents);
      console.log(`Prepared ${fromEvents.length} from scenario`);
    }

    // Fill up to COUNT with random (historic-biased)
    // const remaining = Math.max(0, COUNT - created.length); // todo
    const remaining = Math.max(0, 0);
    if (remaining > 0) {
      const rand = Array.from({ length: remaining }, randomDoc);
      created.push(...rand);
      console.log(`Prepared ${rand.length} random (active ratio ≈ ${ACTIVE_RATIO})`);
    }

    await Disaster.insertMany(created);
    console.log(`✅ Inserted ${created.length} disasters`);
  } catch (e) {
    console.error('Populate error:', e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Done.');
  }
})();
