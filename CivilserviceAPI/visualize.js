// Very simple Leaflet server + FIWARE proxy
// npm i && npm start
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors()); // ok to keep on; you can tighten later
app.use(express.static(path.join(__dirname, 'public')));

const ORION_BASE = process.env.ORION_BASE || 'http://150.140.186.118:1026';
const ORION_URL  = ORION_BASE.replace(/\/$/, '') + '/v2/entities';
const FIWARE_SERVICE_PATH = process.env.FIWARE_SERVICE_PATH || '/up1083865/thesis/Vehicles';
const FIWARE_SERVICE_TENANT = process.env.FIWARE_SERVICE_TENANT; // e.g. "up1083865"
const BASE_ENTITY_ID_PREFIX = process.env.BASE_ENTITY_ID_PREFIX || 'urn:ngsi-ld:Vehicle:CIV';

function fiwareHeaders() {
  const h = { 'Fiware-ServicePath': FIWARE_SERVICE_PATH };
  if (FIWARE_SERVICE_TENANT) h['Fiware-Service'] = FIWARE_SERVICE_TENANT;
  return h;
}

// Convert NGSI v2 entities -> minimal GeoJSON FeatureCollection
function toGeoJSON(entities) {
  const feats = [];
  for (const e of entities) {
    let coords = null;
    const loc = e.location;
    if (loc && typeof loc === 'object') {
      // keyValues: {type:'Point', coordinates:[lon,lat]}
      if (Array.isArray(loc.coordinates)) coords = loc.coordinates;
      // full NGSI: {type:'geo:json', value:{type:'Point', coordinates:[lon,lat]}}
      if (!coords && loc.value && Array.isArray(loc.value.coordinates)) coords = loc.value.coordinates;
    }
    if (!coords || coords.length !== 2) continue;

    const get = (name, dflt = undefined) => {
      const v = e[name];
      return v && typeof v === 'object' && 'value' in v ? v.value : (v ?? dflt);
    };

    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        id: e.id,
        type: get('vehicleType', 'unknown'),
        license_plate: get('license_plate', '-'),
        status: get('status', '-'),
        speed: get('speed', 0),
        lastUpdated: get('lastUpdated', '-')
      }
    });
  }
  return { type: 'FeatureCollection', features: feats };
}

// Simple health
app.get('/health', (_, res) => res.json({ ok: true }));

// Proxy route: GET /vehicles -> GeoJSON
app.get('/vehicles', async (req, res) => {
  try {
    // console.log('Fetching from Orion...');
    const params = { type: 'Vehicle', limit: 1000, options: 'keyValues' };
    const r = await axios.get(ORION_URL, { params, headers: fiwareHeaders(), timeout: 15000 });
    let entities = r.data;
    if (BASE_ENTITY_ID_PREFIX) {
      entities = entities.filter(e => String(e.id || '').startsWith(BASE_ENTITY_ID_PREFIX));
    }
    res.json(toGeoJSON(entities));
  } catch (err) {
    const status = err.response?.status || 502;
    const detail = err.response?.data || String(err);
    res.status(status).json({ error: 'orion_fetch_failed', detail });
  }
});

// Serve index.html by default
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8001;
app.listen(PORT, () => {
  console.log(`✅ leaflet server running on http://localhost:${PORT}`);
});
