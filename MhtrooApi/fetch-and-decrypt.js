#!/usr/bin/env node
/**
 * fetch-and-decrypt.js
 * Makes an authenticated GET to an encrypted endpoint and decrypts the response.
 *
 * Usage examples:
 *   node fetch-and-decrypt.js --url=http://localhost:8090/api/ids/data --token=$AMEA_ACCESS_TOKEN --secret=$AMEA_ENCRYPTION_SECRET
 *   # or via .env (AMEA_ACCESS_TOKEN, AMEA_ENCRYPTION_SECRET, etc.)
 *   node fetch-and-decrypt.js --url=http://localhost:8090/api/ids/data
 *
 * Optional flags:
 *   --out=decrypted.json   Write plaintext JSON to file (also prints to stdout)
 *   --insecure             Skip TLS verification (self-signed certs)
 */

import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';

function arg(name, fallback = undefined) {
  const n = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(n));
  if (hit) return hit.slice(n.length);
  return process.env[name.toUpperCase()] ?? fallback;
}

function boolFlag(name) {
  const key = `--${name}`;
  return process.argv.includes(key);
}

// ------- Inputs -------
const URL = arg('url') || 'http://localhost:8090/api/ids/data';
const TOKEN =
  arg('token') ||
  process.env.AMEA_ACCESS_TOKEN ||
  process.env.ACCESS_TOKEN;
const RAW_SECRET =
  arg('secret') ||
  process.env.AMEA_ENCRYPTION_SECRET ||
  process.env.AMEA_DECRYPTION_SECRET ||
  process.env.DECRYPTION_SECRET;

const OUT = arg('out');
const INSECURE = boolFlag('insecure');

if (!URL) {
  console.error('❌ Missing --url (or API_URL/ENDPOINT_URL in env).');
  process.exit(1);
}
if (!TOKEN) {
  console.error('❌ Missing --token (or AMEA_ACCESS_TOKEN/ACCESS_TOKEN in env).');
  process.exit(1);
}
if (!RAW_SECRET) {
  console.error('❌ Missing --secret (or AMEA_ENCRYPTION_SECRET / AMEA_DECRYPTION_SECRET / DECRYPTION_SECRET in env).');
  process.exit(1);
}

// ------- Key parsing / derivation -------
function getAes256Key(raw) {
  const trimmed = (raw || '').trim();

  // base64?
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return b64;
  } catch {}

  // hex?
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // fallback: treat raw as passphrase, derive with scrypt (same salt as server)
  const salt = Buffer.from('dataspace-api-static-salt', 'utf8');
  return crypto.scryptSync(trimmed, salt, 32);
}
const KEY = getAes256Key(RAW_SECRET);

// ------- Decrypt helper -------
function decryptGCM({ iv, tag, ciphertext }) {
  if (!iv || !tag || !ciphertext) {
    throw new Error('Encrypted payload missing iv/tag/ciphertext properties.');
  }
  const ivBuf = Buffer.from(iv, 'base64');
  const tagBuf = Buffer.from(tag, 'base64');
  const ctBuf = Buffer.from(ciphertext, 'base64');

  const dec = crypto.createDecipheriv('aes-256-gcm', KEY, ivBuf);
  dec.setAuthTag(tagBuf);
  const pt = Buffer.concat([dec.update(ctBuf), dec.final()]);
  return pt.toString('utf8');
}

// ------- Fetch + decrypt -------
(async () => {
  try {
    const httpsAgent = INSECURE ? new https.Agent({ rejectUnauthorized: false }) : undefined;

    const resp = await axios.get(URL, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/json',
      },
      timeout: 20000,
      httpsAgent,
      // if you need proxies, set them via env or axios proxy config
    });

    const body = resp.data;

    // If endpoint already returned plaintext JSON (unexpected), just print it
    if (body && typeof body === 'object' && body.ciphertext && body.iv && body.tag) {
      if (body.alg && body.alg !== 'AES-256-GCM') {
        console.warn(`⚠️  alg is '${body.alg}', expected 'AES-256-GCM'`);
      }
      const plaintext = decryptGCM(body);

      // Try to pretty-print JSON
      let out = plaintext;
      try {
        out = JSON.stringify(JSON.parse(plaintext), null, 2);
      } catch {
        // not JSON, keep as-is
      }

      if (OUT) {
        fs.writeFileSync(OUT, out);
        console.log(`✅ Decrypted payload written to ${OUT}`);
      }
      console.log(out);
    } else {
      // Not encrypted shape; just show what we got
      console.warn('⚠️  Response does not look encrypted; printing raw JSON.');
      console.log(JSON.stringify(body, null, 2));
    }
  } catch (err) {
    if (err.response) {
      console.error(`❌ HTTP ${err.response.status}:`, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(`❌ Error: ${err.message}`);
    }
    process.exit(1);
  }
})();
