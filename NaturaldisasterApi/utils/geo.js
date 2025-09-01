// utils/geo.js
// Random/irregular GeoJSON shapes for Greece (+ helpers)

const GR_BBOX = [19.0, 34.7, 28.5, 41.8]; // [minLon, minLat, maxLon, maxLat]

function deg2rad(d) { return d * Math.PI / 180; }
function rad2deg(r) { return r * 180 / Math.PI; }

function randomPointInGreece() {
  const [minX, minY, maxX, maxY] = GR_BBOX;
  const lon = Math.random() * (maxX - minX) + minX;
  const lat = Math.random() * (maxY - minY) + minY;
  return [lon, lat];
}

// Great-circle destination from [lon,lat] by distanceKm and bearingRad
function destination([lon, lat], distanceKm, bearingRad) {
  const R = 6371; // km
  const φ1 = deg2rad(lat);
  const λ1 = deg2rad(lon);
  const δ = distanceKm / R;
  const θ = bearingRad;

  const sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ),   cosδ = Math.cos(δ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  return [rad2deg(λ2), rad2deg(φ2)];
}

function closeRing(coords) {
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
  return coords;
}

// --- Shape generators ---

// 1) Circle (geodesic)
function circlePolygon(center, radiusKm = 10, sides = 48) {
  const coords = [];
  for (let i = 0; i < sides; i++) {
    const bearing = (2 * Math.PI * i) / sides;
    coords.push(destination(center, radiusKm, bearing));
  }
  closeRing(coords);
  return { type: 'Polygon', coordinates: [coords] };
}

// 2) Ellipse (local planar approx), rotated by rotationDeg
function ellipsePolygon(center, radiusKm = 20, ratio = 0.5, sides = 64, rotationDeg = 0) {
  const [lon0, lat0] = center;
  const latFactor = 110.574; // km per ° lat
  const lonFactor = 111.320 * Math.cos(deg2rad(lat0)); // km per ° lon at this lat
  const a = radiusKm;                 // major
  const b = Math.max(0.2, ratio) * a; // minor
  const rot = deg2rad(rotationDeg);

  const coords = [];
  for (let i = 0; i < sides; i++) {
    const t = (2 * Math.PI * i) / sides;
    let x = a * Math.cos(t);
    let y = b * Math.sin(t);
    // rotate
    const xr = x * Math.cos(rot) - y * Math.sin(rot);
    const yr = x * Math.sin(rot) + y * Math.cos(rot);
    // convert km offsets back to lon/lat degrees
    const dLon = xr / lonFactor;
    const dLat = yr / latFactor;
    coords.push([lon0 + dLon, lat0 + dLat]);
  }
  closeRing(coords);
  return { type: 'Polygon', coordinates: [coords] };
}

// 3) Irregular "blobby" polygon by random radial distances (non self-intersecting)
function irregularPolygon(center, meanRadiusKm = 15, spikes = 28, variance = 0.45, smoothing = 0.2, rotationDeg = 0) {
  const rot = deg2rad(rotationDeg);
  // noisy radii
  const radii = Array.from({ length: spikes }, () => {
    const noise = (Math.random() * 2 - 1) * variance; // [-variance, +variance]
    return Math.max(0.5, meanRadiusKm * (1 + noise));
  });
  // simple smoothing
  for (let k = 0; k < 2; k++) {
    const copy = radii.slice();
    for (let i = 0; i < spikes; i++) {
      const prev = copy[(i - 1 + spikes) % spikes];
      const next = copy[(i + 1) % spikes];
      radii[i] = (1 - smoothing) * copy[i] + (smoothing / 2) * (prev + next);
    }
  }
  // emit points
  const coords = [];
  for (let i = 0; i < spikes; i++) {
    const bearing = rot + (2 * Math.PI * i) / spikes;
    coords.push(destination(center, radii[i], bearing));
  }
  closeRing(coords);
  return { type: 'Polygon', coordinates: [coords] };
}

// 4) Small MultiPolygon (two blobs near each other)
function smallMultiPolygon(center, meanRadiusKm = 12) {
  const offsetBearing = Math.random() * 2 * Math.PI;
  const offsetDist = meanRadiusKm * (0.25 + Math.random() * 0.5);
  const c2 = destination(center, offsetDist, offsetBearing);
  const poly1 = irregularPolygon(center, meanRadiusKm, 22, 0.4, 0.25, Math.random() * 180);
  const poly2 = irregularPolygon(c2, meanRadiusKm * (0.7 + Math.random() * 0.6), 20, 0.45, 0.25, Math.random() * 180);

  return { type: 'MultiPolygon', coordinates: [poly1.coordinates, poly2.coordinates] };
}

// Scale a Polygon around center by factor (local planar approximation)
function scalePolygonAround(center, polygon, factor = 1.0) {
  const [lon0, lat0] = center;
  const latFactor = 110.574;
  const lonFactor = 111.320 * Math.cos(deg2rad(lat0));

  const rings = polygon.coordinates.map(ring => {
    return ring.map(([lon, lat], idx) => {
      if (idx === ring.length - 1) return [lon, lat]; // keep closure exact
      const dxKm = (lon - lon0) * lonFactor;
      const dyKm = (lat - lat0) * latFactor;
      const sxKm = dxKm * factor;
      const syKm = dyKm * factor;
      const newLon = lon0 + sxKm / lonFactor;
      const newLat = lat0 + syKm / latFactor;
      return [newLon, newLat];
    });
  });

  return { type: 'Polygon', coordinates: rings };
}

// Scale Polygon or MultiPolygon
function scaleGeometryAround(center, geom, factor = 1.0) {
  if (!geom) return geom;
  if (geom.type === 'Polygon') {
    return scalePolygonAround(center, geom, factor);
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map(coords =>
      scalePolygonAround(center, { type: 'Polygon', coordinates: coords }, factor).coordinates
    );
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

// Main random shape selector
function randomShapePolygon(center, baseRadiusKm = 15) {
  const r = Math.random();
  if (r < 0.18) { // 18% circle
    return circlePolygon(center, baseRadiusKm, 48);
  } else if (r < 0.48) { // 30% ellipse (elongated)
    const ratio = 0.35 + Math.random() * 0.5; // 0.35..0.85
    const rot = Math.random() * 180;
    return ellipsePolygon(center, baseRadiusKm, ratio, 64, rot);
  } else if (r < 1) { // 52% irregular blob
    const spikes = 18 + Math.floor(Math.random() * 18); // 18..35
    const variance = 0.30 + Math.random() * 0.35; // 0.30..0.65
    const smoothing = 0.12 + Math.random() * 0.20; // 0.12..0.32
    const rot = Math.random() * 180;
    return irregularPolygon(center, baseRadiusKm, spikes, variance, smoothing, rot);
  } else { // 0% multipolygon
    return smallMultiPolygon(center, baseRadiusKm);
  }
}

module.exports = {
  GR_BBOX,
  randomPointInGreece,
  circlePolygon,
  ellipsePolygon,
  irregularPolygon,
  smallMultiPolygon,
  randomShapePolygon,
  scaleGeometryAround
};
