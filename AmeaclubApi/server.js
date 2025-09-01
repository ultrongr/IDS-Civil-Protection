import express from 'express';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';

import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8091;
const DB_PATH = process.env.DB_PATH || './ameaclub.db';

app.use(express.json());

// --- DB (sqlite) ---
const db = new sqlite3.Database(DB_PATH);

// promisified helpers
const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const get = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));

// --- crypto for DB fields (must match populate.js) ---
const KEY_PASSPHRASE = process.env.DB_KEY;
if (!KEY_PASSPHRASE) {
  console.error('❌ Missing DB_KEY in .env');
  process.exit(1);
}
const DB_KEY = crypto.scryptSync(KEY_PASSPHRASE, 'dataspace-api-static-salt', 32);

function dec(b64) {
  if (!b64) return null;
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', DB_KEY, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

function mapMemberRow(r) {
  return {
    id: r.id,
    name: r.name,
    age: r.age,
    phone: dec(r.phone),
    email: dec(r.email),
    addressLine: dec(r.addressLine),
    floor: dec(r.floor),
    latitude: r.latitude,
    longitude: r.longitude,
    disabilityPct: r.disabilityPct
  };
}

function mapCaretakerRow(r) {
  return {
    id: r.id,
    memberId: r.memberId,
    name: r.name,
    phone: r.phone,
    email: r.email,
    description: r.description
  };
}

function mapDisabilityRow(r) {
  let features = {};
  try { features = r.features ? JSON.parse(r.features) : {}; } catch { /* keep {} */ }
  return {
    id: r.id,
    memberId: r.memberId,
    type: r.type,
    features
  };
}

// --- API protection (token + response encryption) ---
const ACCESS_TOKEN =
  process.env.AMEACLUB_ACCESS_TOKEN ||
  process.env.AMEA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;

const ENC_SECRET_RAW =
  process.env.AMEACLUB_ENCRYPTION_SECRET ||
  process.env.AMEA_ENCRYPTION_SECRET ||
  process.env.AMEA_DECRYPTION_SECRET ||
  process.env.DECRYPTION_SECRET;

if (!ACCESS_TOKEN) {
  console.error('❌ Missing access token (set AMEACLUB_ACCESS_TOKEN or AMEA_ACCESS_TOKEN or ACCESS_TOKEN)');
  process.exit(1);
}
if (!ENC_SECRET_RAW) {
  console.error('❌ Missing encryption secret (set AMEACLUB_ENCRYPTION_SECRET or AMEA_ENCRYPTION_SECRET or AMEA_DECRYPTION_SECRET or DECRYPTION_SECRET)');
  process.exit(1);
}

// Parse 32-byte AES key from base64/hex; else derive from passphrase (scrypt)
function parseAes256Key(raw) {
  const v = (raw || '').trim();

  // base64?
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {}

  // hex?
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    return Buffer.from(v, 'hex');
  }

  // fallback: KDF (prefer using a real 32-byte key in env)
  return crypto.scryptSync(v, Buffer.from('dataspace-api-static-salt', 'utf8'), 32);
}

const API_AES_KEY = parseAes256Key(ENC_SECRET_RAW);

// Bearer auth middleware
function bearerAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.set('WWW-Authenticate', 'Bearer realm="ameaclub", charset="UTF-8"');
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  if (m[1] !== ACCESS_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  return next();
}

// Encrypt a UTF-8 string with AES-256-GCM
function encryptUtf8(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit nonce
  const cipher = crypto.createCipheriv('aes-256-gcm', API_AES_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    encoding: 'utf8',
    issuedAt: new Date().toISOString()
  };
}

// ------------------- Swagger (OpenAPI) -------------------
const components = {
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer' }
  },
  schemas: {
    Member: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 1 },
        name: { type: 'string', example: 'Maria Papadopoulou' },
        age: { type: 'integer', example: 42 },
        phone: { type: 'string', example: '+30 6912345678' },
        email: { type: 'string', format: 'email', example: 'maria@example.com' },
        addressLine: { type: 'string', example: 'Leof. Amalias 10, Athens' },
        floor: { type: 'string', example: '2' },
        latitude: { type: 'number', example: 38.2466 },
        longitude: { type: 'number', example: 21.7346 },
        disabilityPct: { type: 'number', example: 67 }
      }
    },
    Caretaker: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        memberId: { type: 'integer' },
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        description: { type: 'string' }
      }
    },
    Disability: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        memberId: { type: 'integer' },
        type: {
          type: 'string',
          enum: ['MOBILITY', 'HEARING', 'VISION', 'INTELLECTUAL', 'AUTISM', 'MENTAL', 'OTHER']
        },
        features: { type: 'object', additionalProperties: true }
      }
    },
    MemberWithRelations: {
      type: 'object',
      allOf: [{ $ref: '#/components/schemas/Member' }],
      properties: {
        caretakers: { type: 'array', items: { $ref: '#/components/schemas/Caretaker' } },
        disabilities: { type: 'array', items: { $ref: '#/components/schemas/Disability' } }
      }
    },
    EncryptedPayload: {
      type: 'object',
      properties: {
        alg: { type: 'string', example: 'AES-256-GCM' },
        iv: { type: 'string', description: 'base64 12-byte IV' },
        tag: { type: 'string', description: 'base64 16-byte GCM tag' },
        ciphertext: { type: 'string', description: 'base64 ciphertext of JSON string' },
        encoding: { type: 'string', example: 'utf8' },
        issuedAt: { type: 'string', format: 'date-time' }
      },
      required: ['alg', 'iv', 'tag', 'ciphertext']
    }
  }
};

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AmeaClub API',
      version: '1.1.0',
      description:
        'API for AmeaClub (SQLite). **Responses are protected with Bearer auth and returned as AES-256-GCM encrypted payloads.**'
    },
    servers: [{ url: process.env.PUBLIC_URL || `http://localhost:${PORT}` }],
    components
  },
  apis: ['./server.js']
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));

/**
 * @swagger
 * tags:
 *   - name: AmeaClub
 *     description: Members, caretakers & disabilities
 */

/**
 * @swagger
 * /api/ameaclub/members:
 *   get:
 *     tags: [AmeaClub]
 *     summary: List all members (ENCRYPTED)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Encrypted JSON array of members
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EncryptedPayload'
 *       401:
 *         description: Missing token
 *       403:
 *         description: Invalid token
 */
app.get('/api/ameaclub/members', bearerAuth, async (_req, res) => {
  try {
    const rows = await all('SELECT * FROM members ORDER BY id');
    const payload = JSON.stringify(rows.map(mapMemberRow));
    const encrypted = encryptUtf8(payload);
    res.set('Cache-Control', 'no-store');
    res.json(encrypted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

/**
 * @swagger
 * /api/ameaclub/members/{id}:
 *   get:
 *     tags: [AmeaClub]
 *     summary: Get a single member with caretakers & disabilities (ENCRYPTED)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Encrypted JSON object with relations
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EncryptedPayload'
 *       401:
 *         description: Missing token
 *       403:
 *         description: Invalid token
 *       404:
 *         description: Not found
 */
app.get('/api/ameaclub/members/:id', bearerAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await get('SELECT * FROM members WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const caretakers = await all('SELECT * FROM caretakers WHERE memberId = ?', [id]);
    const disabilities = await all('SELECT * FROM disabilities WHERE memberId = ?', [id]);

    const obj = {
      ...mapMemberRow(row),
      caretakers: caretakers.map(mapCaretakerRow),
      disabilities: disabilities.map(mapDisabilityRow)
    };

    const encrypted = encryptUtf8(JSON.stringify(obj));
    res.set('Cache-Control', 'no-store');
    res.json(encrypted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`AmeaClub server  http://localhost:${PORT}`);
  console.log(`Swagger docs     http://localhost:${PORT}/docs`);
});
