import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import crypto from 'crypto';
import Amea from './models/Amea.js';

import swaggerUi from 'swagger-ui-express';
import swaggerJSDoc from 'swagger-jsdoc';
import mongooseToSwagger from 'mongoose-to-swagger';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8090;

app.use(express.json());

// ---------- Secrets & Auth ----------

const ACCESS_TOKEN =
  process.env.AMEA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;

const ENCRYPTION_SECRET_RAW =
  process.env.AMEA_ENCRYPTION_SECRET ||
  process.env.AMEA_DECRYPTION_SECRET ||
  process.env.DECRYPTION_SECRET;

if (!ACCESS_TOKEN) {
  throw new Error('Missing ACCESS TOKEN (set AMEA_ACCESS_TOKEN or ACCESS_TOKEN in env).');
}
if (!ENCRYPTION_SECRET_RAW) {
  throw new Error('Missing ENCRYPTION SECRET (set AMEA_ENCRYPTION_SECRET or AMEA_DECRYPTION_SECRET or DECRYPTION_SECRET in env).');
}

// --- add with your other imports/consts ---
function parseAes256Key(raw) {
  const v = String(raw || '').trim();
  try { const b = Buffer.from(v, 'base64'); if (b.length === 32) return b; } catch {}
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  return crypto.scryptSync(v, 'dataspace-api-static-salt', 32);
}
const AES_KEY = getAes256Key(ENCRYPTION_SECRET_RAW); 

// robust decrypt for strings or {iv,tag,ciphertext}
function dec(v) {
  if (v == null) return v;

  // --- Case 1: object { iv, tag, ciphertext } (all base64) -> GCM
  if (typeof v === 'object' && v.iv && (v.ciphertext || v.ct)) {
    const iv  = Buffer.from(v.iv,  'base64');
    const ct  = Buffer.from(v.ciphertext || v.ct, 'base64');
    const tag = v.tag ? Buffer.from(v.tag, 'base64') : null;
    const d = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
    if (tag) d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  if (typeof v !== 'string') return v;

  const s = v.trim();

  // --- Case 3: legacy "iv:cipher" where both parts are hex -> AES-256-CBC
  // iv must be 32 hex chars (16 bytes)
  const m = s.match(/^([0-9a-fA-F]{32}):([0-9a-fA-F]+)$/);
  if (m) {
    try {
      const iv = Buffer.from(m[1], 'hex');
      const ct = Buffer.from(m[2], 'hex');
      const d = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
      // CBC typically used PKCS#7 padding
      d.setAutoPadding(true);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) {
      // fall through to other formats if this fails
    }
  }

  // --- Case 2: compact base64 (try GCM iv|tag|ct then iv|ct|tag)
  // also accept URL-safe base64
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    const raw  = Buffer.from(norm, 'base64');
    const IV = 12, TAG = 16;
    if (raw.length >= IV + TAG + 1) {
      const iv   = raw.subarray(0, IV);
      const tagA = raw.subarray(IV, IV + TAG);
      const ctA  = raw.subarray(IV + TAG);
      const tagB = raw.subarray(raw.length - TAG);
      const ctB  = raw.subarray(IV, raw.length - TAG);

      const tryGcm = (tag, ct) => {
        const d = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      };

      try { return tryGcm(tagA, ctA); } catch {}
      try { return tryGcm(tagB, ctB); } catch {}
    }
  } catch {}

  // Not an encrypted value we recognize — return as-is so you can see it in logs
  return v;
}


// helper to decrypt known PII fields in a doc (adjust to your schema)
function decryptAmea(doc) {
  const out = { ...doc };

  out.name     = dec(out.name);
  out.surname  = dec(out.surname);
  out.email    = dec(out.email?.value ?? out.email);
  out.phoneNumber =
    typeof out.phoneNumber === 'object'
      ? { ...out.phoneNumber, value: dec(out.phoneNumber.value) }
      : dec(out.phoneNumber);

  // optional address-ish fields – tweak for your schema
  out.address       = dec(out.address);
  out.addressLine   = dec(out.addressLine);
  out.floor         = dec(out.floor);

  return out;
}


/** Parse the 256-bit (32-byte) key from base64 or hex (preferred), else derive from a passphrase via scrypt */
function getAes256Key(raw) {
  // try base64
  try {
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) return b64;
  } catch {}
  // try hex
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    return Buffer.from(raw, 'hex');
  }
  // fallback: treat as passphrase and KDF a key (salt is static to keep server deterministic;
  // rotate to a real random salt when you move to a secrets manager)
  const salt = Buffer.from('dataspace-api-static-salt', 'utf8');
  return crypto.scryptSync(raw, salt, 32);
}

// const AES_KEY = getAes256Key(ENCRYPTION_SECRET_RAW);

/** Require Authorization: Bearer <token> */
function bearerAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.set('WWW-Authenticate', 'Bearer realm="amea", charset="UTF-8"');
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = m[1];
  if (token !== ACCESS_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  return next();
}

/** Encrypt a UTF-8 string with AES-256-GCM; returns { iv, tag, ciphertext } (all base64) */
function encryptUtf8(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    encoding: 'utf8',
    issuedAt: new Date().toISOString(),
  };
}

// ---------- MongoDB ----------
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// ---------- Swagger ----------
const ameaSwaggerSchema = mongooseToSwagger(Amea);
console.log("Mongo uri :", process.env.MONGO_URI);

const serverUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Amea API',
      version: '1.0.0',
      description:
        'API for managing Amea (people with disabilities) in Greece. The /api/ids/data endpoint is protected by Bearer token and returns AES-256-GCM encrypted payload.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Amea: ameaSwaggerSchema,
        EncryptedPayload: {
          type: 'object',
          properties: {
            alg: { type: 'string', example: 'AES-256-GCM' },
            iv: { type: 'string', description: 'base64 12-byte IV' },
            tag: { type: 'string', description: 'base64 16-byte GCM tag' },
            ciphertext: { type: 'string', description: 'base64 ciphertext of JSON string' },
            encoding: { type: 'string', example: 'utf8' },
            issuedAt: { type: 'string', format: 'date-time' },
          },
          required: ['alg', 'iv', 'tag', 'ciphertext'],
        },
      },
    },
  },
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ---------- Routes ----------

/**
 * @swagger
 * /api/ids/data:
 *   get:
 *     summary: Get all Amea entries (ENCRYPTED)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: AES-256-GCM encrypted payload containing the JSON array of Amea entries.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EncryptedPayload'
 *       401:
 *         description: Missing bearer token
 *       403:
 *         description: Invalid token
 *       500:
 *         description: Server error
 */
app.get('/api/ids/data', bearerAuth, async (req, res) => {
  try {
    const ameas = await Amea.find();
    ameas.forEach(amea => amea.decryptFieldsSync())
    const clean = ameas.map(amea => amea.toObject());

    const plaintext = JSON.stringify(clean);

    const encrypted = encryptUtf8(plaintext);
    res.set('Cache-Control', 'no-store');
    res.status(200).json(encrypted);
  } catch (err) {
    console.error('Fetch/encrypt error:', err.message);
    res.status(500).json({ error: 'Failed to fetch/encrypt Amea data' });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on ${serverUrl}`);
  console.log(`Swagger docs available at ${serverUrl}/docs`);
});
