// populate_seeded.js (ESM) — mhtroo: seed from JSON/GeoJSON of existing AMEA
// Usage:
//   node populate_seeded.js ./amea_seed.json
//   SEED_JSON=./amea_seed.json node populate_seeded.js
// Env:
//   MONGO_URI=mongodb://127.0.0.1:27017/amea
//   KEEP=1   (do NOT clear existing Amea docs before insert)

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { faker } from '@faker-js/faker';
import Amea from './models/Amea.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Helpers ----------
function readJson(anyPath) {
  const full = path.isAbsolute(anyPath) ? anyPath : path.resolve(__dirname, anyPath);
  if (!fs.existsSync(full)) throw new Error(`Seed file not found: ${full}`);
  const txt = fs.readFileSync(full, 'utf8');
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`Cannot parse JSON from ${full}: ${e.message}`);
  }
}

function isFeatureCollection(obj) {
  return obj && obj.type === 'FeatureCollection' && Array.isArray(obj.features);
}

function* iterateSeedItems(seed) {
  if (Array.isArray(seed)) {
    for (const item of seed) yield item;
    return;
  }
  if (isFeatureCollection(seed)) {
    for (const feat of seed.features) {
      if (!feat || feat.type !== 'Feature') continue;
      const g = feat.geometry || {};
      const p = feat.properties || {};
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      yield { ...p, coordinates: g.coordinates };
    }
    return;
  }
  // Single object fallback
  yield seed;
}

function pick(obj, keys) {
  const out = {}; keys.forEach(k => { if (obj && obj[k] != null) out[k] = obj[k]; }); return out;
}

function toBool01(v, fallback = 1) {
  if (v === 1 || v === 0) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1','true','yes','y'].includes(s)) return 1;
    if (['0','false','no','n'].includes(s)) return 0;
  }
  return fallback;
}

function parseCoords(item) {
  // Accept several shapes: {loc:{type:'Point',coordinates:[lon,lat]}}, {coordinates:[lon,lat]},
  // {lon,lat} or {longitude,latitude}
  if (item?.loc?.type === 'Point' && Array.isArray(item.loc.coordinates) && item.loc.coordinates.length >= 2) {
    const [lon, lat] = item.loc.coordinates; return [Number(lon), Number(lat)];
  }
  if (Array.isArray(item?.coordinates) && item.coordinates.length >= 2) {
    const [lon, lat] = item.coordinates; return [Number(lon), Number(lat)];
  }
  if (('lon' in (item||{})) && ('lat' in (item||{}))) {
    return [Number(item.lon), Number(item.lat)];
  }
  if (("longitude" in (item||{})) && ("latitude" in (item||{}))) {
    return [Number(item.longitude), Number(item.latitude)];
  }
  throw new Error('Missing coordinates for item');
}

const REGION_BY_CITY = new Map([
  ['Athens',       'Attica'],
  ['Thessaloniki', 'Central Macedonia'],
  ['Patras',       'Western Greece'],
  ['Heraklion',    'Crete'],
  ['Larissa',      'Thessaly'],
  ['Ioannina',     'Epirus']
]);

function normalizeAmeaDoc(raw) {
  const [lon, lat] = parseCoords(raw);

  // Prefer provided fields; otherwise fallback to faker
  const name = raw.name || raw.firstName || faker.person.firstName();
  const surname = raw.surname || raw.lastName || faker.person.lastName();

  const municipality = raw?.region?.municipality || raw.municipality || raw.city || 'Unknown';
  const administrative = raw?.region?.administrative || raw.region || REGION_BY_CITY.get(municipality) || faker.helpers.arrayElement([
    'Attica', 'Central Macedonia', 'Crete', 'Thessaly', 'Epirus', 'Western Greece']
  );

  const emailValue = raw?.email?.value || raw.email || faker.internet.email();
  const emailActive = toBool01(raw?.email?.active ?? raw?.emailActive ?? 1);

  const phoneMob = raw?.phoneNumber?.value || raw.phoneNumber || faker.phone.number('+30 69########');
  const phoneMobActive = toBool01(raw?.phoneNumber?.active ?? raw?.phoneActive ?? 1);

  const landNumber = raw?.landNumber?.value || raw.landNumber || faker.phone.number('+30 2#########');
  const landActive = toBool01(raw?.landNumber?.active ?? 0);

  const disabilitiesDesc = raw.disabilitiesDesc || raw.description || raw.notes || faker.lorem.sentence();
  const disabilities = Array.isArray(raw.disabilities) && raw.disabilities.length ? raw.disabilities : [raw.disability || faker.word.adjective()];

  const address = raw.address || `${faker.number.int({min:1,max:220})} ${faker.helpers.arrayElement(['Egnatia','Ermou','Patision','Kifisias','Panepistimiou','Venizelou','Tsimiski'])}, ${municipality}`;

  const caretaker = {
    carename: raw?.caretaker?.carename || faker.person.firstName(),
    caresurname: raw?.caretaker?.caresurname || faker.person.lastName(),
    careemail: raw?.caretaker?.careemail || faker.internet.email(),
    carephone: raw?.caretaker?.carephone || faker.phone.number('+30 69########'),
    caredescription: raw?.caretaker?.caredescription || faker.lorem.sentence(),
    parent: toBool01(raw?.caretaker?.parent ?? 0)
  };

  const status = raw.status || faker.helpers.arrayElement(['active', 'pending', 'cancelled']);

  return {
    // Pass through any known top-level identifiers if present
    ...pick(raw, ['externalId','source','sourceFile']),

    name,
    surname,
    email: { value: emailValue, active: emailActive },
    phoneNumber: { value: phoneMob, active: phoneMobActive },
    landNumber: { value: landNumber, active: landActive },
    mandatoryCommunication: raw.mandatoryCommunication || 'email',

    loc: { type: 'Point', coordinates: [lon, lat] },

    region: { administrative, municipality },

    disabilities,
    disabilitiesDesc,
    disabilityPct: Number(raw.disabilityPct ?? faker.number.int({ min: 20, max: 100 })),

    floor: Number(raw.floor ?? faker.number.int({ min: 0, max: 10 })),
    birthday: raw.birthday || faker.date.birthdate({ min: 30, max: 85, mode: 'age' }),
    address,

    caretaker,

    status,
    group_club: raw.group_club || faker.company.name(),
    activity_problem: Number(raw.activity_problem ?? faker.number.int({ min: 0, max: 1 })),
    cardAmeaNumber: raw.cardAmeaNumber || faker.string.alphanumeric(10),
    mustVerify: Boolean(raw.mustVerify ?? faker.datatype.boolean())
  };
}

async function main() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/amea';
    const keep = process.env.KEEP === '1' || process.env.KEEP === 'true';

    // Resolve seed path from argv or env
    const seedPath = process.argv[2] || process.env.SEED_JSON;
    if (!seedPath) throw new Error('Please provide a seed JSON path: node populate_seeded.js ./amea_seed.json');

    console.log(`🔌 Connecting to MongoDB at ${mongoUri}`);
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected');

    if (!keep) {
      await Amea.deleteMany({});
      console.log('🧹 Cleared existing Amea docs (use KEEP=1 to skip)');
    } else {
      console.log('↩️  KEEP=1 set — will not clear existing docs');
    }

    console.log(`📥 Loading seed from ${seedPath}`);
    const raw = readJson(seedPath);

    const docs = [];
    let total = 0, used = 0, skipped = 0;

    for (const item of iterateSeedItems(raw)) {
      total++;
      try {
        const doc = normalizeAmeaDoc(item);
        docs.push(doc);
        used++;
      } catch (e) {
        skipped++;
        console.warn(`⚠️  Skipping item #${total}: ${e.message}`);
      }
    }

    if (!docs.length) throw new Error('No valid items with coordinates found in seed file.');

    await Amea.insertMany(docs, { ordered: false });
    console.log(`✅ Inserted ${docs.length} Amea docs (processed: ${total}, skipped: ${skipped})`);

    const count = await Amea.countDocuments();
    console.log(`📊 Collection size now: ${count}`);

    await mongoose.disconnect();
    console.log('🔌 Disconnected');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding error:', err);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
}

main();
