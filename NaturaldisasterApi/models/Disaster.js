// models/Disaster.js
const mongoose = require('mongoose');

// Generic GeoJSON geometry (Polygon or MultiPolygon)
const geoJSONGeometry = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Polygon', 'MultiPolygon'],
    required: true
  },
  coordinates: {
    type: Array, // keep generic; you can tighten this later
    required: true
  }
}, { _id: false });

const naturalDisasterSchema = new mongoose.Schema({
  type: { type: String }, // e.g., wildfire, flood, earthquake, storm
  description: { type: String },
  dangerLevel: { type: String, enum: ['low', 'moderate', 'high', 'extreme'] },

  // ✅ DO NOT wrap in { type: geoJSONGeometry }
  areaOfEffect: {
    type: geoJSONGeometry, // <-- this "type" is Mongoose’s path option, pointing to a Schema
    required: true
  },

  startDate: { type: Date },
  endDate: { type: Date },

  // ✅ Arrays should be declared as [geoJSONGeometry], not { type: [geoJSONGeometry] }
  historicalAreasOfEffect: {
    type: [geoJSONGeometry],
    default: []
  },
  projectedAreasOfEffect: {
    type: [geoJSONGeometry],
    default: []
  },

  updatedAt: { type: Date, default: Date.now },
  source: { type: String }
}, { timestamps: true });

naturalDisasterSchema.index({ areaOfEffect: '2dsphere' });

module.exports = mongoose.model('Disaster', naturalDisasterSchema);
