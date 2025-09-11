// populate_seeded_sqlite.js (ESM) — amea club: seed members from JSON/GeoJSON of existing AMEA
// Usage:
//   node populate_seeded_sqlite.js ./amea_seed.json
//   SEED_JSON=./amea_seed.json node populate_seeded_sqlite.js
// Env:
//   DB_PATH=./ameaclub.db
//   DB_KEY=<passphrase for AES-256-GCM PII encryption>
//   KEEP=1  (do NOT clear existing rows before insert)

import sqlite3pkg from 'sqlite3';
const sqlite3 = sqlite3pkg.verbose();
import { faker } from '@faker-js/faker';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const DB_PATH = process.env.DB_PATH || './ameaclub.db';
const KEEP = process.env.KEEP === '1' || process.env.KEEP === 'true';

// ---------- Encryption (same scheme as your existing script) ----------
const KEY_PASSPHRASE = process.env.DB_KEY;
if (!KEY_PASSPHRASE) {
  console.error('❌ Missing DB_KEY in env');
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

// ---------- Seed input helpers ----------
function readJson(anyPath) {
  const full = path.isAbsolute(anyPath) ? anyPath : path.resolve(__dirname, anyPath);
  if (!fs.existsSync(full)) throw new Error(`Seed file not found: ${full}`);
  const txt = fs.readFileSync(full, 'utf8');
  try { return JSON.parse(txt); } catch (e) { throw new Error(`Cannot parse JSON from ${full}: ${e.message}`); }
}

function isFeatureCollection(obj) {
  return obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features);
}

function* iterateSeedItems(seed) {
  if (Array.isArray(seed)) { for (const it of seed) yield it; return; }
  if (isFeatureCollection(seed)) {
    for (const f of seed.features) {
      if (!f || f.type !== 'Feature') continue;
      const g = f.geometry || {}; const p = f.properties || {};
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      yield { ...p, coordinates: g.coordinates };
    }
    return;
  }
  yield seed; // single object fallback
}

function parseCoords(item) {
  if (item?.loc?.type === 'Point' && Array.isArray(item.loc.coordinates) && item.loc.coordinates.length >= 2) {
    const [lon, lat] = item.loc.coordinates; return [Number(lon), Number(lat)];
  }
  if (Array.isArray(item?.coordinates) && item.coordinates.length >= 2) {
    const [lon, lat] = item.coordinates; return [Number(lon), Number(lat)];
  }
  if (("lon" in (item||{})) && ("lat" in (item||{}))) return [Number(item.lon), Number(item.lat)];
  if (("longitude" in (item||{})) && ("latitude" in (item||{}))) return [Number(item.longitude), Number(item.latitude)];
  throw new Error('Missing coordinates for item');
}

function toInt(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

function calcAgeFromBirthday(bday) {
  try {
    const d = new Date(bday);
    if (isNaN(d.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    const m = today.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
    return age;
  } catch { return null; }
}

// Catalog for disabilities → feature JSON
const disabilityCatalog = {
  MOBILITY:     { type: 'MOBILITY',     features: { ramp: true, elevator: true } },
  HEARING:      { type: 'HEARING',      features: { captions: true, signLanguage: true } },
  VISION:       { type: 'VISION',       features: { braille: true, audioGuides: true } },
  INTELLECTUAL: { type: 'INTELLECTUAL', features: { simpleLanguage: true } },
  AUTISM:       { type: 'AUTISM',       features: { quietRoom: true } },
  MENTAL:       { type: 'MENTAL',       features: { counseling: true } },
  OTHER:        { type: 'OTHER',        features: {} }
};

function normalizeDisabilityType(s) {
  if (!s) return 'OTHER';
  const t = String(s).toLowerCase();
  if (/(mobility|wheelchair|orthopedic)/.test(t)) return 'MOBILITY';
  if (/(hearing|deaf|sign)/.test(t)) return 'HEARING';
  if (/(vision|visual|blind|braille)/.test(t)) return 'VISION';
  if (/(intellect|cognitive|learning)/.test(t)) return 'INTELLECTUAL';
  if (/(autis)/.test(t)) return 'AUTISM';
  if (/(mental|psycho|anx|depress)/.test(t)) return 'MENTAL';
  return 'OTHER';
}

function buildMemberFromSeed(raw) {
  const [lon, lat] = parseCoords(raw);

  const fullName = `${raw.name || raw.firstName || faker.person.firstName()} ${raw.surname || raw.lastName || faker.person.lastName()}`.trim();
  const age = toInt(raw.age, calcAgeFromBirthday(raw.birthday)) ?? faker.number.int({ min: 18, max: 90 });

  // Phones/emails may come as nested objects or plain strings
  const phone = raw?.phoneNumber?.value || raw.phoneNumber || faker.phone.number('+30 69########');
  const email = (raw?.email?.value || raw.email || faker.internet.email({ firstName: fullName.split(' ')[0] }));

  const addressLine = raw.address || raw.addressLine || `${faker.location.streetAddress({ useFullAddress: true })}`;
  const floor = String(raw.floor ?? faker.number.int({ min: 0, max: 5 }));
  const disabilityPct = toInt(raw.disabilityPct, faker.number.int({ min: 20, max: 100 }));

  const disabilities = Array.isArray(raw.disabilities) && raw.disabilities.length ? raw.disabilities : (raw.disability ? [raw.disability] : []);
  const disabilitiesDesc = raw.disabilitiesDesc || raw.description || raw.notes || null;

  // Caretaker fields (optional)
  const ct = raw.caretaker || {};
  const caretakerName = (ct.carename || ct.name || faker.person.fullName()) + (ct.caresurname ? ` ${ct.caresurname}` : '');
  const caretakerPhone = ct.carephone || ct.phone || faker.phone.number('+30 210#######');
  const caretakerEmail = ct.careemail || ct.email || faker.internet.email({ firstName: caretakerName.split(' ')[0] });
  const caretakerDesc = ct.caredescription || ct.description || (ct.parent ? 'Parent' : faker.lorem.sentence());

  return {
    member: {
      name: fullName,
      age,
      phone: enc(phone),
      email: enc(email),
      addressLine: enc(addressLine),
      floor: enc(floor),
      latitude: lat,
      longitude: lon,
      disabilityPct
    },
    caretaker: { name: caretakerName, phone: caretakerPhone, email: caretakerEmail, description: caretakerDesc },
    disabilities,
    disabilitiesDesc
  };
}

function disabilitiesToRows(disabilities, disabilitiesDesc) {
  const rows = [];
  for (const d of disabilities) {
    const key = normalizeDisabilityType(d);
    const base = disabilityCatalog[key] || disabilityCatalog.OTHER;
    rows.push({ type: base.type, features: JSON.stringify(base.features) });
  }
  if (disabilitiesDesc) {
    rows.push({ type: 'OTHER', features: JSON.stringify({ notes: String(disabilitiesDesc) }) });
  }
  if (!rows.length) {
    // Ensure at least one row
    rows.push({ type: 'OTHER', features: JSON.stringify({}) });
  }
  return rows;
}

async function main() {
  try {
    const seedPath = process.argv[2] || process.env.SEED_JSON;
    if (!seedPath) throw new Error('Please provide a seed JSON path: node populate_seeded_sqlite.js ./amea_seed.json');

    const raw = readJson(seedPath);
    const docs = [];
    let total = 0, skipped = 0;
    for (const item of iterateSeedItems(raw)) {
      total++;
      try { docs.push(buildMemberFromSeed(item)); }
      catch (e) { skipped++; console.warn(`⚠️  Skipping item #${total}: ${e.message}`); }
    }
    if (!docs.length) throw new Error('No valid items with coordinates found in seed file.');

    const db = new sqlite3.Database(DB_PATH);

    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        age INTEGER,
        phone TEXT,
        email TEXT,
        addressLine TEXT,
        floor TEXT,
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

      if (!KEEP) {
        db.run('DELETE FROM caretakers');
        db.run('DELETE FROM disabilities');
        db.run('DELETE FROM members');
        console.log('🧹 Cleared existing rows (KEEP=1 to skip)');
      } else {
        console.log('↩️  KEEP=1 set — will not clear existing rows');
      }

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

      let created = 0;

      for (const d of docs) {
        const m = d.member;
        insertMember.run([
          m.name, m.age, m.phone, m.email, m.addressLine, m.floor, m.latitude, m.longitude, m.disabilityPct
        ], function (err) {
          if (err) { console.error('Member insert error:', err); return; }
          const memberId = this.lastID;
          const c = d.caretaker;
          insertCaretaker.run([memberId, c.name, c.phone, c.email, c.description]);
          for (const row of disabilitiesToRows(d.disabilities, d.disabilitiesDesc)) {
            insertDisability.run([memberId, row.type, row.features]);
          }
          created++;
        });
      }

      // Give sqlite time to flush prepared runs (simple approach similar to your existing script)
      setTimeout(() => {
        insertMember.finalize();
        insertCaretaker.finalize();
        insertDisability.finalize();
        db.run('COMMIT', (err) => {
          if (err) console.error('Commit error:', err);
          else console.log(`✅ Inserted ${created} members (processed: ${total}, skipped: ${skipped}) into ${DB_PATH}`);
          db.close();
        });
      }, 600);
    });
  } catch (err) {
    console.error('❌ Seed error:', err.message || err);
    process.exit(1);
  }
}

main();
