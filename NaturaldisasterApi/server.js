require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Disaster = require('./models/Disaster');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Mongo ----
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/disasters';
mongoose.connect(MONGO_URI, { dbName: 'disasters' })
  .then(() => console.log('Mongo connected'))
  .catch(err => console.error('Mongo error:', err));

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// IDS endpoint
app.get('/api/ids/data', async (req, res) => {
    try {
    const { minLon, minLat, maxLon, maxLat } = req.query;
    if ([minLon, minLat, maxLon, maxLat].every(v => v !== undefined)) {
      const rect = {
        type: 'Polygon',
        coordinates: [[
          [parseFloat(minLon), parseFloat(minLat)],
          [parseFloat(maxLon), parseFloat(minLat)],
          [parseFloat(maxLon), parseFloat(maxLat)],
          [parseFloat(minLon), parseFloat(maxLat)],
          [parseFloat(minLon), parseFloat(minLat)]
        ]]
      };
      const docs = await Disaster.find({
        areaOfEffect: { $geoIntersects: { $geometry: rect } }
      }).lean();
      return res.json(docs);
    }
    const docs = await Disaster.find().lean();
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// List disasters (optional bbox filter)
app.get('/disasters', async (req, res) => {
  try {
    const { minLon, minLat, maxLon, maxLat } = req.query;
    if ([minLon, minLat, maxLon, maxLat].every(v => v !== undefined)) {
      const rect = {
        type: 'Polygon',
        coordinates: [[
          [parseFloat(minLon), parseFloat(minLat)],
          [parseFloat(maxLon), parseFloat(minLat)],
          [parseFloat(maxLon), parseFloat(maxLat)],
          [parseFloat(minLon), parseFloat(maxLat)],
          [parseFloat(minLon), parseFloat(minLat)]
        ]]
      };
      const docs = await Disaster.find({
        areaOfEffect: { $geoIntersects: { $geometry: rect } }
      }).lean();
      return res.json(docs);
    }
    const docs = await Disaster.find().lean();
    res.json(docs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Get one
app.get('/disasters/:id', async (req, res) => {
  try {
    const doc = await Disaster.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dev-only clear
app.delete('/disasters', async (_, res) => {
  try {
    const r = await Disaster.deleteMany({});
    res.json({ deleted: r.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Add in server.js ---

// Serve disasters as GeoJSON FeatureCollection (optionally ?active=true)
app.get('/disasters.geojson', async (req, res) => {
  try {
    const { active } = req.query;
    const query = {};

    if (active === 'true') {
      // active = no endDate OR endDate in the future
      query.$or = [{ endDate: null }, { endDate: { $gt: new Date() } }];
    }

    const docs = await Disaster.find(query).lean();

    const features = docs.map(d => {
      const {
        _id, __v,
        areaOfEffect,
        historicalAreasOfEffect,
        projectedAreasOfEffect,
        ...props
      } = d;

      return {
        type: 'Feature',
        geometry: areaOfEffect,              // Polygon / MultiPolygon
        properties: {
          id: String(_id),
          ...props,
          // Include counts so the client knows they exist (optional)
          historicalCount: (historicalAreasOfEffect || []).length,
          projectedCount: (projectedAreasOfEffect || []).length
        }
      };
    });

    res.json({ type: 'FeatureCollection', features });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


// --- Add in server.js ---

app.get('/map', (req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Greece Disasters</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <style>
    html, body, #map { height: 100%; margin: 0; }
    .legend { background: white; padding: 6px 8px; font: 12px/14px Arial; border-radius: 4px; }
    .legend .swatch { display:inline-block; width:12px; height:12px; margin-right:6px; vertical-align:middle; }
  </style>
</head>
<body>
  <div id="map"></div>

  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>
  <script>
    // Base map (OSM)
    const map = L.map('map', { preferCanvas: true }).setView([38.6, 23.1], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors'
    }).addTo(map);

    // Color by danger level
    const colors = {
      low: '#2ecc71',
      moderate: '#f1c40f',
      high: '#e67e22',
      extreme: '#e74c3c'
    };
    function styleByDanger(feature) {
      const lvl = feature.properties?.dangerLevel || 'moderate';
      const color = colors[lvl] || '#3498db';
      return {
        weight: 2,
        opacity: 1,
        color: color,
        fillOpacity: 0.25,
        fillColor: color
      };
    }

    // Popup template
    function popupHtml(p) {
      const dt = v => (v ? new Date(v).toLocaleString('el-GR') : '—');
      return \`
        <div>
          <strong>Type:</strong> \${p.type || '—'}<br/>
          <strong>Danger:</strong> \${p.dangerLevel || '—'}<br/>
          <strong>Start:</strong> \${dt(p.startDate)}<br/>
          <strong>End:</strong> \${dt(p.endDate)}<br/>
          <strong>Source:</strong> \${p.source || '—'}<br/>
          <small>Updated: \${dt(p.updatedAt)}</small>
        </div>
      \`;
    }

    // Load GeoJSON (only active by default)
    fetch('/disasters.geojson?active=true')
      .then(r => r.json())
      .then(fc => {
        const layer = L.geoJSON(fc, {
          style: styleByDanger,
          onEachFeature: (feature, layer) => {
            layer.bindPopup(popupHtml(feature.properties));
          }
        }).addTo(map);

        try {
          map.fitBounds(layer.getBounds(), { padding: [20, 20] });
        } catch (e) {
          // if no polygons yet, ignore
        }

        // Add a simple legend
        const legend = L.control({ position: 'bottomleft' });
        legend.onAdd = function () {
          const div = L.DomUtil.create('div', 'legend');
          div.innerHTML = \`
            <div><span class="swatch" style="background:\${colors.low}"></span>low</div>
            <div><span class="swatch" style="background:\${colors.moderate}"></span>moderate</div>
            <div><span class="swatch" style="background:\${colors.high}"></span>high</div>
            <div><span class="swatch" style="background:\${colors.extreme}"></span>extreme</div>
          \`;
          return div;
        };
        legend.addTo(map);
      })
      .catch(err => console.error('GeoJSON load error:', err));
  </script>
</body>
</html>`);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Disaster server on :${PORT}`));
