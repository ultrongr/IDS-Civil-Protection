#!/usr/bin/env node
/**
 * discover-negotiate-save.js
 *
 * Consumer-only discovery + contract negotiation + payload saving.
 * Saves payloads AS-IS (no redaction).
 *
 * ENV (.env):
 *   CONSUMER_URL=               # e.g. https://localhost:8081
 *   BROKER_API=                 # e.g. https://broker-reverseproxy/infrastructure
 *   BROKER_REV_PROXY=           # e.g. https://broker-reverseproxy
 *   ADMIN_USERNAME=admin
 *   ADMIN_PASSWORD=password
 *
 *   KEYWORDS=amea,club,civilservice,naturaldisaster
 *   OUTPUT_DIR=./outputs
 *   INSECURE_TLS=true
 *
 *   # Optional: fallback provider aliases if broker discovery is unreliable
 *   PROVIDER_ALIASES=https://connectorcivilservice:8084,https://connectormhtroo:8082,https://connectornaturaldisaster:8084
 */

import 'dotenv/config';
import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Config ----------
const {
  CONSUMER_URL,
  BROKER_API,
  BROKER_REV_PROXY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  KEYWORDS = '',
  OUTPUT_DIR = './outputs',
  INSECURE_TLS,
  PROVIDER_ALIASES = '',
} = process.env;

if (!CONSUMER_URL || !BROKER_API || !BROKER_REV_PROXY) {
  console.error('❌ Missing required env: CONSUMER_URL, BROKER_API, BROKER_REV_PROXY');
  process.exit(1);
}

const keywords = KEYWORDS.split(',').map((s) => s.trim()).filter(Boolean);
if (keywords.length === 0) {
  console.warn('⚠️  KEYWORDS is empty; all offers will be considered matches.');
}

// ---------- Axios defaults ----------
axios.defaults.httpsAgent = new https.Agent({
  rejectUnauthorized: !/^true$/i.test(INSECURE_TLS || ''),
});
axios.defaults.auth = {
  username: ADMIN_USERNAME || '',
  password: ADMIN_PASSWORD || '',
};

// ---------- Helpers ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const wait = (ms) => (ms ? sleep(ms) : Promise.resolve());
const WAIT_MS = 200; // light pacing

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 100);
}
function idSuffix(s) {
  const str = String(s || '');
  return str.slice(-10).replace(/[^a-zA-Z0-9]/g, '');
}

// Walk any JSON and collect IDS access URLs found under hasDefaultEndpoint/accessURL
function collectAccessUrls(obj, acc = new Set()) {
  if (!obj || typeof obj !== 'object') return acc;
  if (obj['ids:hasDefaultEndpoint']?.['ids:accessURL']?.['@id']) {
    acc.add(obj['ids:hasDefaultEndpoint']['ids:accessURL']['@id']);
  }
  if (Array.isArray(obj['ids:hasDefaultEndpoint'])) {
    for (const ep of obj['ids:hasDefaultEndpoint']) {
      const url = ep?.['ids:accessURL']?.['@id'];
      if (url) acc.add(url);
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) v.forEach((x) => collectAccessUrls(x, acc));
    else if (v && typeof v === 'object') collectAccessUrls(v, acc);
  }
  return acc;
}

function textify(val) {
  if (Array.isArray(val)) {
    const parts = [];
    for (const it of val) {
      if (it && typeof it === 'object' && '@value' in it) parts.push(String(it['@value']));
      else if (typeof it === 'string') parts.push(it);
    }
    return parts.join(' ');
  }
  if (val && typeof val === 'object' && '@value' in val) return String(val['@value']);
  if (typeof val === 'string') return val;
  return '';
}

function matchKeywords(resource, kwds) {
  if (kwds.length === 0) return true;
  const hay = [
    textify(resource['ids:title']),
    textify(resource['ids:description']),
    textify(resource['ids:keyword']),
    textify(resource['ids:keywords']),
  ]
    .join(' ')
    .toLowerCase();
  return kwds.some((k) => hay.includes(k.toLowerCase()));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// If payload is a URL string, follow it; if JSON string, parse; otherwise return as object
async function normalizePayload(payload) {
  if (typeof payload === 'string' && /^https?:\/\//i.test(payload)) {
    const r = await axios.get(payload);
    return r.data;
  }
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function extractAccessUrlsFromConnector(c, byId) {
  const endpoints = (c['ids:hasDefaultEndpoint'] ?? c.hasDefaultEndpoint);
  const epRefs = Array.isArray(endpoints) ? endpoints : (endpoints ? [endpoints] : []);
  const urls = new Set();

  for (const epRef of epRefs) {
    const epId = typeof epRef === 'string' ? epRef : epRef?.['@id'];
    const epNode = (epId && byId[epId]) || epRef || {};
    const access = epNode['ids:accessURL'] ?? epNode.accessURL;

    const add = (v) => {
      if (!v) return;
      if (typeof v === 'string') urls.add(v);
      else if (typeof v === 'object' && v['@id']) urls.add(v['@id']);
    };

    if (Array.isArray(access)) access.forEach(add);
    else add(access);
  }
  return [...urls];
}

function pickPublicUrl(arr) {
  const scored = arr.map(u => {
    try {
      const { protocol, hostname } = new URL(u);
      const score = (protocol === 'https:' ? 2 : 0) + (/\./.test(hostname) ? 1 : 0);
      return { u, score };
    } catch { return { u, score: -1 }; }
  }).sort((a,b)=>b.score-a.score);
  return scored[0]?.u;
}

// ---------- Core flow ----------
(async () => {
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(__dirname, OUTPUT_DIR, runStamp);
  ensureDir(outDir);

  const runSummary = {
    startedAt: new Date().toISOString(),
    consumer: CONSUMER_URL,
    broker: BROKER_API,
    keywords,
    outDir,
    matches: [],
    errors: [],
  };

  try {
    console.log('🔗 Registering consumer at broker (optional but common)...');
    await axios.post(`${CONSUMER_URL}/api/ids/connector/update`, null, {
      params: { recipient: BROKER_API },
    });
  } catch (e) {
    console.warn('⚠️  Consumer registration failed/ignored:', e.response?.status || e.message);
  }

  await wait(WAIT_MS);

  // Discover connectors from broker
  console.log('🔎 Discovering connectors from broker...');
  let accessUrls = new Set();

  try {
    const listResp = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
      params: { recipient: BROKER_API, elementId: `${BROKER_REV_PROXY}/connectors/` },
    });

    const data = listResp.data;
    const graph = data['@graph'] || [];
    const byId = Object.fromEntries(graph.map(n => [n['@id'], n]));

    const connectors = graph.filter(n => n['@type'] === 'ids:BaseConnector');
    const results = connectors.map(c => {
      const urls = extractAccessUrlsFromConnector(c, byId);
      const chosen = pickPublicUrl(urls);
      return {
        connectorId: c['@id'],
        sameAs: c['ids:sameAs'] ?? c.sameAs,
        accessURLs: urls,
        accessURL: chosen
      };
    }).filter(r => r.accessURL);

    accessUrls = new Set(results.map(r => r.accessURL));
    console.log(`   • Connector access URLs discovered: ${accessUrls.size}`);
  } catch (e) {
    console.warn('⚠️  Broker connector listing failed:', e.response?.status || e.message);
  }

  // Fallback to explicit aliases if provided
  const aliasList = (process.env.PROVIDER_ALIASES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of aliasList) accessUrls.add(a);

  if (accessUrls.size === 0) {
    console.error('❌ No provider connectors found (via broker nor PROVIDER_ALIASES).');
    process.exit(2);
  }

  // Iterate providers
  for (const baseUrl of accessUrls) {
    // console.log(accessUrls)
    const recipient = `${baseUrl.replace(/\/+$/, '')}`;
    const providerSlug = slugify(baseUrl);
    console.log(`\n📡 Provider: ${baseUrl}`);
    console.log('   📜 Self-description -> catalogs', recipient);

    try {
      // Self-description -> catalogs
      const sd = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
        params: { recipient },
      });
      const catalogs = Array.isArray(sd.data?.['ids:resourceCatalog'])
        ? sd.data['ids:resourceCatalog'].map((x) => x['@id']).filter(Boolean)
        : [];

      console.log(`   • Catalogs: ${catalogs.length}`);
      if (catalogs.length === 0) continue;

      for (const catId of catalogs) {
        await wait(WAIT_MS);
        const cat = await axios.post(`${CONSUMER_URL}/api/ids/description`, null, {
          params: { recipient, elementId: catId },
        });

        const resources = Array.isArray(cat.data?.['ids:offeredResource'])
          ? cat.data['ids:offeredResource']
          : [];
        console.log(`   • Resources in catalog ${idSuffix(catId)}: ${resources.length}`);

        for (const res of resources) {
          if (!matchKeywords(res, keywords)) continue;

          const resourceId = res['@id'];
          const title = textify(res['ids:title']) || '(no title)';
          const desc = textify(res['ids:description']);
          const reps = Array.isArray(res['ids:representation']) ? res['ids:representation'] : [];
          const firstRep = reps[0] || {};
          const instances = Array.isArray(firstRep['ids:instance']) ? firstRep['ids:instance'] : [];
          const artifactId = instances[0]?.['@id'];

          if (!artifactId) {
            console.log(`   • Skipping ${idSuffix(resourceId)} — no artifact instance`);
            continue;
          }

          console.log(`   ✅ Match: "${title}"  (#${idSuffix(resourceId)})`);

          // Negotiate contract
          await wait(WAIT_MS);
          const permissions = [
            {
              '@type': 'ids:Permission',
              'ids:title': [{ '@value': 'Usage Policy', '@type': 'http://www.w3.org/2001/XMLSchema#string' }],
              'ids:action': [{ '@id': 'https://w3id.org/idsa/code/USE' }],
              'ids:target': artifactId,
            },
          ];

          let agreementId = null;
          try {
            const contractResp = await axios.post(`${CONSUMER_URL}/api/ids/contract`, permissions, {
              params: {
                recipient,
                resourceIds: resourceId,
                artifactIds: artifactId,
                download: false,
              },
              headers: { 'Content-Type': 'application/ld+json' },
            });
            const agreementHref = contractResp.data?._links?.self?.href || '';
            agreementId = agreementHref.split('/').pop();
          } catch (e) {
            console.warn(`   ⚠️  Contract negotiation failed for ${idSuffix(resourceId)}:`, e.response?.status || e.message);
            runSummary.errors.push({
              provider: baseUrl,
              resourceId,
              step: 'contract',
              error: e.response?.data || e.message,
            });
            continue;
          }

          // Fetch data link
          await wait(WAIT_MS);
          let dataLink = null;
          try {
            const dl = await axios.get(`${CONSUMER_URL}/api/agreements/${agreementId}/artifacts`);
            dataLink = dl.data?._embedded?.artifacts?.[0]?._links?.data?.href || null;
          } catch (e) {
            console.warn(`   ⚠️  Getting data link failed:`, e.response?.status || e.message);
            runSummary.errors.push({
              provider: baseUrl,
              resourceId,
              agreementId,
              step: 'data-link',
              error: e.response?.data || e.message,
            });
            continue;
          }

          if (!dataLink) {
            console.warn('   ⚠️  No data link returned.');
            continue;
          }

          // Download payload
          await wait(WAIT_MS);
          let payload;
          try {
            const payloadResp = await axios.get(dataLink);
            payload = await normalizePayload(payloadResp.data);
          } catch (e) {
            console.warn('   ⚠️  Payload fetch/normalize failed:', e.response?.status || e.message);
            runSummary.errors.push({
              provider: baseUrl,
              resourceId,
              agreementId,
              step: 'payload',
              error: e.response?.data || e.message,
            });
            continue;
          }

          // Save files (RAW, no redaction)
          const baseName = `${providerSlug}_${idSuffix(resourceId)}`;
          const metaPath = path.join(outDir, `${baseName}.meta.json`);
          const dataPath = path.join(outDir, `${baseName}.json`);

          const meta = {
            providerBase: baseUrl,
            recipient,
            resource: { id: resourceId, title, description: desc },
            artifactId,
            agreementId,
            dataLink,
            savedAt: new Date().toISOString(),
          };
          // writeJson(metaPath, meta);
          writeJson(dataPath, payload);

          console.log(`   💾 Saved RAW: ${path.relative(__dirname, dataPath)}  (meta: ${path.relative(__dirname, metaPath)})`);

          // Track in run summary
          runSummary.matches.push({
            providerBase: baseUrl,
            resourceId,
            title,
            artifactId,
            agreementId,
            dataLink,
            files: { metaPath, dataPath },
          });
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Provider walk failed:`, e.response?.status || e.message);
      runSummary.errors.push({
        provider: baseUrl,
        step: 'provider-walk',
        error: e.response?.data || e.message,
      });
    }
  }

  // Write run summary
  runSummary.finishedAt = new Date().toISOString();
  const summaryPath = path.join(outDir, `run-summary.json`);
  // writeJson(summaryPath, runSummary);

  console.log('\n✅ Done.');
  console.log(`📁 Output dir: ${outDir}`);
  console.log(`🧾 Summary: ${summaryPath}`);
})().catch((err) => {
  console.error('❌ Fatal:', err.response?.data || err.message);
  process.exit(1);
});
