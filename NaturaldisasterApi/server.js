require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Disaster = require('./models/Disaster');

// 🔹 Swagger
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Mongo ----
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/disasters';
mongoose.connect(MONGO_URI, { dbName: 'disasters' })
  .then(() => console.log('Mongo connected'))
  .catch(err => console.error('Mongo error:', err));

// ---- Swagger setup ----
const components = {
  schemas: {
    GeoJSONGeometry: {
      type: 'object',
      required: ['type', 'coordinates'],
      properties: {
        type: { type: 'string', enum: ['Polygon', 'MultiPolygon'] },
        coordinates: { type: 'array', items: { type: 'array' } }
      },
      example: {
        type: 'Polygon',
        coordinates: [[[21.73,38.23],[21.75,38.23],[21.75,38.26],[21.73,38.26],[21.73,38.23]]]
      }
    },
    Disaster: {
      type: 'object',
      properties: {
        _id: { type: 'string' },
        type: { type: 'string', example: 'wildfire' },
        description: { type: 'string' },
        dangerLevel: { type: 'string', enum: ['low','moderate','high','extreme'] },
        areaOfEffect: { $ref: '#/components/schemas/GeoJSONGeometry' },
        startDate: { type: 'string', format: 'date-time' },
        endDate: { type: 'string', format: 'date-time', nullable: true },
        historicalAreasOfEffect: {
          type: 'array',
          items: { $ref: '#/components/schemas/GeoJSONGeometry' }
        },
        projectedAreasOfEffect: {
          type: 'array',
          items: { $ref: '#/components/schemas/GeoJSONGeometry' }
        },
        updatedAt: { type: 'string', format: 'date-time' },
        source: { type: 'string', example: 'effis_api' },
        sourceId: { type: 'string' }
      }
    },
    GeoJSONFeature: {
      type: 'object',
      properties: {
        type: { type: 'string', example: 'Feature' },
        geometry: { $ref: '#/components/schemas/GeoJSONGeometry' },
        properties: { type: 'object' }
      }
    },
    GeoJSONFeatureCollection: {
      type: 'object',
      properties: {
        type: { type: 'string', example: 'FeatureCollection' },
        features: {
          type: 'array',
          items: { $ref: '#/components/schemas/GeoJSONFeature' }
        }
      }
    },
    Error: {
      type: 'object',
      properties: { error: { type: 'string' } }
    }
  }
};

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Natural Disasters API',
      version: '1.0.0',
      description: 'Public, read-only API serving natural disaster polygons (MongoDB → Express).'
    },
    servers: [{ url: process.env.PUBLIC_URL || `http://localhost:${PORT}` }],
    components
  },
  apis: [__filename]  // this file
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     responses:
 *       200:
 *         description: Liveness probe
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 */

/**
 * @swagger
 * /api/ids/data:
 *   get:
 *     summary: List disasters (same payload used by consumers)
 *     description: >
 *       Returns raw disaster documents. Optionally filter by bounding box query params.
 *     parameters:
 *       - in: query
 *         name: minLon
 *         schema: { type: number }
 *       - in: query
 *         name: minLat
 *         schema: { type: number }
 *       - in: query
 *         name: maxLon
 *         schema: { type: number }
 *       - in: query
 *         name: maxLat
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Array of disaster docs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Disaster' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
app.get('/health', (_, res) => res.json({ ok: true }));

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

/**
 * @swagger
 * /disasters:
 *   get:
 *     summary: List disasters
 *     description: >
 *       Returns raw disaster documents. Optional bounding box filter with
 *       `minLon,minLat,maxLon,maxLat` (WGS84).
 *     parameters:
 *       - in: query
 *         name: minLon
 *         schema: { type: number }
 *       - in: query
 *         name: minLat
 *         schema: { type: number }
 *       - in: query
 *         name: maxLon
 *         schema: { type: number }
 *       - in: query
 *         name: maxLat
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Array of disaster docs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Disaster' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
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

/**
 * @swagger
 * /disasters/{id}:
 *   get:
 *     summary: Get a single disaster
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Disaster document
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Disaster' }
 *       404:
 *         description: Not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
app.get('/disasters/:id', async (req, res) => {
  try {
    const doc = await Disaster.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /disasters:
 *   delete:
 *     summary: Dev-only clear of all disasters
 *     responses:
 *       200:
 *         description: Delete summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: integer, example: 12 }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
app.delete('/disasters', async (_, res) => {
  try {
    const r = await Disaster.deleteMany({});
    res.json({ deleted: r.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /disasters.geojson:
 *   get:
 *     summary: Disasters as GeoJSON FeatureCollection
 *     parameters:
 *       - in: query
 *         name: active
 *         schema: { type: string, enum: ['true','false'] }
 *         description: If true, returns only active disasters (no endDate or endDate in future).
 *     responses:
 *       200:
 *         description: GeoJSON FeatureCollection (Polygon/MultiPolygon)
 *         content:
 *           application/geo+json:
 *             schema: { $ref: '#/components/schemas/GeoJSONFeatureCollection' }
 *           application/json:
 *             schema: { $ref: '#/components/schemas/GeoJSONFeatureCollection' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
app.get('/disasters.geojson', async (req, res) => {
  try {
    const { active } = req.query;
    const query = {};
    if (active === 'true') {
      query.$or = [{ endDate: null }, { endDate: { $gt: new Date() } }];
    }
    const docs = await Disaster.find(query).lean();
    const features = docs.map(d => {
      const { _id, __v, areaOfEffect, historicalAreasOfEffect, projectedAreasOfEffect, ...props } = d;
      return {
        type: 'Feature',
        geometry: areaOfEffect,
        properties: {
          id: String(_id),
          ...props,
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

/**
 * @swagger
 * /map:
 *   get:
 *     summary: Minimal Leaflet viewer for disasters
 *     responses:
 *       200:
 *         description: HTML page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 */
app.get('/map', (req, res) => {
  res.send(`<!doctype html>
<html lang="en"> ... (unchanged HTML from your version) ... </html>`);
});

app.listen(PORT, () => console.log(`Disaster server on :${PORT}  •  Swagger: http://localhost:${PORT}/docs`));
