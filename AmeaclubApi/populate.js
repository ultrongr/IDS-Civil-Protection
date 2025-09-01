// populate.js (ESM) — weighted cities + no-sea placement
import sqlite3pkg from 'sqlite3';
const sqlite3 = sqlite3pkg.verbose();
import { faker } from '@faker-js/faker';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const DB_PATH = './ameaclub.db';
const N = Number(process.env.SEED_COUNT || 50); // total members

// ---------- Load Greece land polygon (pick the first file that exists) ----------
const LAND_CANDIDATES = [
  process.env.LAND_GEOJSON || './greece-land.geojson',
  './greece-land1.geojson',
  './greece-land2.geojson'
];

function loadLand() {
  for (const p of LAND_CANDIDATES) {
    try {
      const full = path.resolve(p);
      if (!fs.existsSync(full)) continue;
      const fc = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (fc && fc.type === 'FeatureCollection' && Array.isArray(fc.features) && fc.features.length) {
        // keep only Polygon/MultiPolygon
        const feats = fc.features.filter(f => f.geometry && /Polygon/i.test(f.geometry.type));
        if (feats.length) {
          return { type: 'FeatureCollection', features: feats };
        }
      }
    } catch {}
  }
  throw new Error('No land GeoJSON found. Set LAND_GEOJSON or put greece-land.geojson next to this script.');
}
const LAND = loadLand();

// ---------- Geometry helpers (lon/lat planar checks are fine here) ----------
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
  // outer ring
  if (!pointInRing([x, y], rings[0])) return false;
  // holes
  for (let r = 1; r < rings.length; r++) {
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

// ---------- Weighted areas (edit these) ----------
const AREAS = [
  { name: 'Athens',       center: [23.7275, 37.9838], radiusKm: 25, weight: 0.45, biasExp: 1.1 },
  { name: 'Thessaloniki', center: [22.9444, 40.6403], radiusKm: 18, weight: 0.35, biasExp: 1.0 },
  { name: 'Patras',       center: [21.7346, 38.2466], radiusKm:  9, weight: 0.20, biasExp: 0.9 },
];

// sanity normalize
const wsum = AREAS.reduce((s, a) => s + (a.weight || 0), 0) || 1;
AREAS.forEach(a => a.weight = (a.weight || 0) / wsum);

// allocate counts by weight (largest remainder)
function allocateCounts(total, areas) {
  const exact = areas.map(a => total * a.weight);
  const base = exact.map(Math.floor);
  let r = total - base.reduce((s, v) => s + v, 0);
  const fracIdx = exact
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);
  for (let k = 0; k < r; k++) base[fracIdx[k]]++;
  return base;
}

// random point in circle on lon/lat (approx; small radii)
// random point in circle on lon/lat (biasExp: 0.5 = uniform; >0.5 = center-heavy; <0.5 = edge-heavy)
function randomPointInCircle([lon0, lat0], radiusKm, biasExp = 0.5) {
  const R = 6371; // Earth radius km
  const u = Math.random();
  const v = Math.random();

  // uniform area would be sqrt(u); we generalize to u^biasExp
  const distRad   = (radiusKm / R) * Math.pow(u, biasExp);
  const bearing   = 2 * Math.PI * v;

  const lat0r = lat0 * Math.PI / 180;
  const lon0r = lon0 * Math.PI / 180;

  const lat = Math.asin(Math.sin(lat0r) * Math.cos(distRad) +
                        Math.cos(lat0r) * Math.sin(distRad) * Math.cos(bearing));
  const lon = lon0r + Math.atan2(Math.sin(bearing) * Math.sin(distRad) * Math.cos(lat0r),
                                 Math.cos(distRad) - Math.sin(lat0r) * Math.sin(lat));
  return [((lon * 180 / Math.PI + 540) % 360) - 180, lat * 180 / Math.PI];
}


// fallback: rejection sample inside land bbox
function randomPointInLand() {
  // rough bbox of all features
  let minX=180, minY=90, maxX=-180, maxY=-90;
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
  return [23.7275, 37.9838]; // Athens center fallback
}

// ---------- crypto (same as server) ----------
const KEY_PASSPHRASE = process.env.DB_KEY;
if (!KEY_PASSPHRASE) {
  console.error('❌ Missing DB_KEY in .env');
  process.exit(1);
}
const KEY = crypto.scryptSync(KEY_PASSPHRASE, 'dataspace-api-static-salt', 32);
function enc(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

// disabilities
const disabilityCatalog = [
  { type: 'MOBILITY',     features: JSON.stringify({ ramp: true, elevator: true }) },
  { type: 'HEARING',      features: JSON.stringify({ captions: true, signLanguage: true }) },
  { type: 'VISION',       features: JSON.stringify({ braille: true, audioGuides: true }) },
  { type: 'INTELLECTUAL', features: JSON.stringify({ simpleLanguage: true }) },
  { type: 'AUTISM',       features: JSON.stringify({ quietRoom: true }) },
  { type: 'MENTAL',       features: JSON.stringify({ counseling: true }) },
  { type: 'OTHER',        features: '{}' }
];
function randomDisabilities() {
  const shuffled = faker.helpers.shuffle(disabilityCatalog);
  const k = faker.number.int({ min: 1, max: 2 });
  return shuffled.slice(0, k);
}

// ---------- DB ----------
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    age INTEGER,
    phone TEXT,        -- ENCRYPTED
    email TEXT,        -- ENCRYPTED
    addressLine TEXT,  -- ENCRYPTED
    floor TEXT,        -- ENCRYPTED
    latitude REAL,
    longitude REAL,
    disabilityPct REAL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS caretakers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memberId INTEGER,
    name TEXT,
    phone TEXT,
    email TEXT,
    description TEXT,
    FOREIGN KEY(memberId) REFERENCES members(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS disabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memberId INTEGER,
    type TEXT,
    features TEXT,
    FOREIGN KEY(memberId) REFERENCES members(id)
  )`);

  db.run('DELETE FROM caretakers');
  db.run('DELETE FROM disabilities');
  db.run('DELETE FROM members');

  db.run('BEGIN TRANSACTION');

  const insertMember = db.prepare(
    `INSERT INTO members (name, age, phone, email, addressLine, floor, latitude, longitude, disabilityPct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCaretaker = db.prepare(
    `INSERT INTO caretakers (memberId, name, phone, email, description)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertDisability = db.prepare(
    `INSERT INTO disabilities (memberId, type, features)
     VALUES (?, ?, ?)`
  );

  // allocate how many per area
  const counts = allocateCounts(N, AREAS);

  // generate
  let created = 0;
  AREAS.forEach((area, idx) => {
    for (let k = 0; k < counts[idx]; k++) {
      // sample a point inside the area AND on land
      let pt = null;
      for (let tries = 0; tries < 200; tries++) {
        const exp = area.biasExp ?? Number(process.env.RADIUS_EXP || 0.5);
        const cand = randomPointInCircle(area.center, area.radiusKm, exp);

        if (pointInLand(cand)) { pt = cand; break; }
      }
      if (!pt) pt = randomPointInLand(); // rare fallback
      const [lon, lat] = pt;

      const name = faker.person.fullName();
      const age = faker.number.int({ min: 18, max: 90 });
      const phone = faker.phone.number('+30 69########');
      const email = faker.internet.email({ firstName: name.split(' ')[0] });
      const addressLine = faker.location.streetAddress({ useFullAddress: true });
      const floor = `${faker.number.int({ min: 0, max: 5 })}`;
      const disabilityPct = faker.number.int({ min: 20, max: 100 });

      insertMember.run(
        [ name, age, enc(phone), enc(email), enc(addressLine), enc(floor), lat, lon, disabilityPct ],
        function (err) {
          if (err) { console.error('Member insert error:', err); return; }
          const memberId = this.lastID;
          const cName = faker.person.fullName();
          const cPhone = faker.phone.number('+30 210#######');
          const cEmail = faker.internet.email({ firstName: cName.split(' ')[0] });
          const cDesc = faker.lorem.sentence();

          insertCaretaker.run([memberId, cName, cPhone, cEmail, cDesc]);
          for (const d of randomDisabilities()) insertDisability.run([memberId, d.type, d.features]);
        }
      );
      created++;
    }
  });

  setTimeout(() => {
    insertMember.finalize();
    insertCaretaker.finalize();
    insertDisability.finalize();
    db.run('COMMIT', (err) => {
      if (err) console.error('Commit error:', err);
      else console.log(`✅ Seeded ${created} members into ${DB_PATH}`);
      db.close();
    });
  }, 500);
});
