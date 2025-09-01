#!/usr/bin/env node
/**
 * ameaclub-fetch-decrypt.js
 *
 * Examples:
 *   node ameaclub-fetch-decrypt.js --url=http://localhost:8091/api/ameaclub/members --token=$AMEACLUB_ACCESS_TOKEN --secret=$AMEACLUB_ENCRYPTION_SECRET
 *   node ameaclub-fetch-decrypt.js --base=http://localhost:8091 --id=5
 *   node ameaclub-fetch-decrypt.js --url=https://host/api/ameaclub/members --insecure --out=members.json
 */

import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';

function arg(name, fallback) {
  const key = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(key));
  if (hit) return hit.slice(key.length);
  return process.env[name.toUpperCase()] ?? fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// ---- inputs ----
const BASE = arg('base'); // e.g. http://localhost:8091
const ID = arg('id');     // optional numeric id
let URL = arg('url');     // full URL overrides base/id
if (!URL) {
  const base = BASE || 'http://localhost:8091';
  URL = ID ? `${base}/api/ameaclub/members/${ID}` : `${base}/api/ameaclub/members`;
}

const TOKEN =
  arg('token') ||
  process.env.AMEACLUB_ACCESS_TOKEN ||
  process.env.AMEA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;

const RAW_SECRET =
  arg('secret') ||
  process.env.AMEACLUB_ENCRYPTION_SECRET ||
  process.env.AMEA_ENCRYPTION_SECRET ||
  process.env.AMEA_DECRYPTION_SECRET ||
  process.env.DECRYPTION_SECRET;

const OUT = arg('out');           // optional output file
const INSECURE = flag('insecure'); // self-signed TLS

if (!TOKEN) {
  console.error('❌ Missing token (use --token or set AMEACLUB_ACCESS_TOKEN / AMEA_ACCESS_TOKEN / ACCESS_TOKEN)');
  process.exit(1);
}
if (!RAW_SECRET) {
  console.error('❌ Missing secret (use --secret or set AMEACLUB_ENCRYPTION_SECRET / AMEA_ENCRYPTION_SECRET / AMEA_DECRYPTION_SECRET / DECRYPTION_SECRET)');
  process.exit(1);
}

// ---- key parsing / derivation ----
function getAes256Key(raw) {
  const v = (raw || '').trim();
  // base64?
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === 32) return b;
  } catch {}
  // hex?
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  // fallback: passphrase -> scrypt (use real 32B key in prod)
  return crypto.scryptSync(v, Buffer.from('dataspace-api-static-salt', 'utf8'), 32);
}
const KEY = getAes256Key(RAW_SECRET);

// ---- decrypt helper ----
function decryptGCM(payload) {
  const { iv, tag, ciphertext } = payload || {};
  if (!iv || !tag || !ciphertext) throw new Error('Encrypted payload missing iv/tag/ciphertext');
  const ivB = Buffer.from(iv, 'base64');
  const tagB = Buffer.from(tag, 'base64');
  const ctB = Buffer.from(ciphertext, 'base64');
  const dec = crypto.createDecipheriv('aes-256-gcm', KEY, ivB);
  dec.setAuthTag(tagB);
  const pt = Buffer.concat([dec.update(ctB), dec.final()]);
  return pt.toString('utf8');
}

// ---- fetch + decrypt ----
(async () => {
  try {
    const httpsAgent = INSECURE ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    const resp = await axios.get(URL, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      timeout: 20000,
      httpsAgent
    });

    const body = resp.data;

    // If not encrypted, just print raw (shouldn’t happen if server is configured)
    if (!(body && body.iv && body.tag && body.ciphertext)) {
      console.warn('⚠️ Response not in encrypted shape; printing raw:');
      const rawOut = JSON.stringify(body, null, 2);
      if (OUT) fs.writeFileSync(OUT, rawOut);
      console.log(rawOut);
      return;
    }

    const plaintext = decryptGCM(body);
    let pretty = plaintext;
    try { pretty = JSON.stringify(JSON.parse(plaintext), null, 2); } catch {}

    if (OUT) {
      fs.writeFileSync(OUT, pretty);
      console.log(`✅ Decrypted payload written to ${OUT}`);
    }
    console.log(pretty);
  } catch (err) {
    if (err.response) {
      console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(`❌ Error: ${err.message}`);
    }
    process.exit(1);
  }
})();
