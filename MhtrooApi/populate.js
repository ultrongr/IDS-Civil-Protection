// populate.js (ESM) — mhtroo: weighted areas + land-only + center-biased points
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { faker } from '@faker-js/faker';
import Amea from './models/Amea.js';

dotenv.config();

// ---------- Config ----------
const N = Number(process.env.SEED_COUNT || process.env.MHTROO_SEED_COUNT || 75);

// Land GeoJSON candidates (same as your other seeder)
const LAND_CANDIDATES = [
  process.env.LAND_GEOJSON || './greece-land.geojson',
  './greece-land1.geojson',
  './greece-land2.geojson'
];

// Weighted areas (name, [lon,lat], radiusKm, weight, optional biasExp)
const AREAS = [
  { name: 'Athens',        center: [23.7275, 37.9838], radiusKm: 25, weight: 0.45, biasExp: 1.2 },
  { name: 'Thessaloniki',  center: [22.9444, 40.6403], radiusKm: 18, weight: 0.30, biasExp: 1.1 },
  { name: 'Patras',        center: [21.7346, 38.2466], radiusKm: 10, weight: 0.15, biasExp: 1.0 },
  // { name: 'Heraklion',     center: [25.1442, 35.3387], radiusKm: 12, weight: 0.05, biasExp: 1.0 },
  // { name: 'Larissa',       center: [22.4191, 39.6390], radiusKm: 10, weight: 0.03, biasExp: 0.9 },
  // { name: 'Ioannina',      center: [20.8520, 39.6675], radiusKm: 10, weight: 0.02, biasExp: 0.9 }
];
// normalize weights
{
  const w = AREAS.reduce((s, a) => s + (a.weight || 0), 0) || 1;
  AREAS.forEach(a => (a.weight = (a.weight || 0) / w));
}

// Optional global radial bias override (0.5 = uniform, >0.5 = center-heavy)
const GLOBAL_BIAS = process.env.RADIUS_EXP ? Number(process.env.RADIUS_EXP) : undefined;

// ---------- Load land polygons ----------
function loadLand() {
  for (const p of LAND_CANDIDATES) {
    try {
      const full = path.resolve(p);
      if (!fs.existsSync(full)) continue;
      const fc = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (fc?.type === 'FeatureCollection' && Array.isArray(fc.features) && fc.features.length) {
        const feats = fc.features.filter(f => f.geometry && /Polygon/i.test(f.geometry.type));
        if (feats.length) {
          return { type: 'FeatureCollection', features: feats };
        }
      }
    } catch {}
  }
  throw new Error('No land GeoJSON found. Set LAND_GEOJSON or place greece-land.geojson next to this script.');
}
const LAND = loadLand();

// ---------- Geometry helpers (planar-enough for small extents) ----------
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
function pointInPolygon([x, y], poly) {
  const rings = poly.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (!pointInRing([x, y], rings[0])) return false; // outer
  for (let r = 1; r < rings.length; r++) {          // holes
    if (pointInRing([x, y], rings[r])) return false;
  }
  return true;
}
function pointInMultiPolygon([x, y], mpoly) {
  return mpoly.coordinates.some(poly => pointInPolygon([x, y], { type: 'Polygon', coordinates: poly }));
}
function pointInLand([lon, lat]) {
  for (const f of LAND.features) {
    const g = f.geometry;
    if (g.type === 'Polygon' && pointInPolygon([lon, lat], g)) return true;
    if (g.type === 'MultiPolygon' && pointInMultiPolygon([lon, lat], g)) return true;
  }
  return false;
}

// ---------- Random sampling ----------
function allocateCounts(total, areas) {
  const exact = areas.map(a => total * a.weight);
  const base = exact.map(Math.floor);
  let r = total - base.reduce((s, v) => s + v, 0);
  const fracIdx = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (let k = 0; k < r; k++) base[fracIdx[k]]++;
  return base;
}

// random point inside a circle on the sphere (biasExp: 0.5 uniform, >0.5 center-heavy)
function randomPointInCircle([lon0, lat0], radiusKm, biasExp = 0.5) {
  const R = 6371; // km
  const u = Math.random();
  const v = Math.random();
  const distRad = (radiusKm / R) * Math.pow(u, biasExp);
  const bearing = 2 * Math.PI * v;

  const lat0r = (lat0 * Math.PI) / 180;
  const lon0r = (lon0 * Math.PI) / 180;

  const lat = Math.asin(
    Math.sin(lat0r) * Math.cos(distRad) +
    Math.cos(lat0r) * Math.sin(distRad) * Math.cos(bearing)
  );
  const lon = lon0r + Math.atan2(
    Math.sin(bearing) * Math.sin(distRad) * Math.cos(lat0r),
    Math.cos(distRad) - Math.sin(lat0r) * Math.sin(lat)
  );
  return [((lon * 180 / Math.PI + 540) % 360) - 180, (lat * 180 / Math.PI)];
}

// fallback: rejection sample anywhere in Greece bbox until on land
function randomPointInLand() {
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const f of LAND.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates.flat();
    for (const ring of polys) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  for (let i = 0; i < 5000; i++) {
    const lon = minX + Math.random() * (maxX - minX);
    const lat = minY + Math.random() * (maxY - minY);
    if (pointInLand([lon, lat])) return [lon, lat];
  }
  return [23.7275, 37.9838]; // Athens fallback
}

// Region mapping to make properties look nicer
const REGION_BY_CITY = new Map([
  ['Athens',       'Attica'],
  ['Thessaloniki', 'Central Macedonia'],
  ['Patras',       'Western Greece'],
  ['Heraklion',    'Crete'],
  ['Larissa',      'Thessaly'],
  ['Ioannina',     'Epirus']
]);

// ---------- Connect + seed ----------
(async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/amea';
    console.log(`🔌 Connecting to MongoDB at ${mongoUri}`);
    await mongoose.connect(mongoUri)//, { dbName: process.env.DB_NAME || 'amea' });
    console.log('✅ MongoDB connected');

    await Amea.deleteMany({});
    console.log('🧹 Cleared existing Amea docs');

    const greekStreets = ['Egnatia', 'Ermou', 'Patision', 'Kifisias', 'Panepistimiou', 'Venizelou', 'Tsimiski'];

    const counts = allocateCounts(N, AREAS);
    const docs = [];

    AREAS.forEach((area, idx) => {
      const count = counts[idx];
      const bias = GLOBAL_BIAS ?? area.biasExp ?? 0.5;

      for (let k = 0; k < count; k++) {
        // sample inside circle and ensure it’s on land
        let pt = null;
        for (let tries = 0; tries < 200; tries++) {
          const cand = randomPointInCircle(area.center, area.radiusKm, bias);
          if (pointInLand(cand)) { pt = cand; break; }
        }
        if (!pt) pt = randomPointInLand();
        const [lon, lat] = pt;

        const city = area.name;
        const admin = REGION_BY_CITY.get(city) || faker.helpers.arrayElement([
          'Attica', 'Central Macedonia', 'Crete', 'Thessaly', 'Epirus', 'Western Greece'
        ]);
        const street = faker.helpers.arrayElement(greekStreets);

        docs.push({
          name: faker.person.firstName(),
          surname: faker.person.lastName(),
          email: {
            value: faker.internet.email(),
            active: faker.datatype.boolean() ? 1 : 0
          },
          phoneNumber: {
            value: faker.phone.number('+30 69########'),
            active: faker.datatype.boolean() ? 1 : 0
          },
          landNumber: {
            value: faker.phone.number('+30 2#########'),
            active: faker.datatype.boolean() ? 1 : 0
          },
          mandatoryCommunication: 'email',
          loc: { type: 'Point', coordinates: [lon, lat] }, // [lon, lat]
          region: { administrative: admin, municipality: city },
          disabilities: [faker.word.adjective()],
          disabilitiesDesc: faker.lorem.sentence(),
          disabilityPct: faker.number.int({ min: 20, max: 100 }),
          floor: faker.number.int({ min: 0, max: 10 }),
          birthday: faker.date.birthdate({ min: 30, max: 85, mode: 'age' }),
          address: `${faker.number.int({ min: 1, max: 220 })} ${street}, ${city}`,
          caretaker: {
            carename: faker.person.firstName(),
            caresurname: faker.person.lastName(),
            careemail: faker.internet.email(),
            carephone: faker.phone.number('+30 69########'),
            caredescription: faker.lorem.sentence(),
            parent: faker.datatype.boolean() ? 1 : 0
          },
          status: faker.helpers.arrayElement(['active', 'pending', 'cancelled']),
          group_club: faker.company.name(),
          activity_problem: faker.number.int({ min: 0, max: 1 }),
          cardAmeaNumber: faker.string.alphanumeric(10),
          mustVerify: faker.datatype.boolean()
        });
      }
    });

    await Amea.insertMany(docs, { ordered: false });
    console.log(`✅ Inserted ${docs.length} Amea docs across ${AREAS.length} areas`);
    // fetch amea records to check
    const records = await Amea.find().lean();
    console.log(`✅ Fetched ${records.length} Amea docs`);
    console.log('✅ Seeding complete');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding error:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
