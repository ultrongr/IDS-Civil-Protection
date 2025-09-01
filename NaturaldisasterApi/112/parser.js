// clean_alerts.js
// Transform a saved X/Twitter v2 response into a clean alert array with places split into source/destination.
// Detects "Περιφερειακή Ενότητα <tag>" and records it separately.

const fs = require("fs");
const INPUT = process.argv[2] || "tweets.json";
const OUTPUT = process.argv[3] || "alerts_clean.json";

const raw = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
const tweets = raw.data || raw;

// --- helpers ---
function detectLang(text) {
  return /[Α-Ωα-ω]/.test(text) ? "el" : "en";
}

function uniquePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = typeof x === "string" ? x.toLowerCase() : x;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}

function normaliseTag(tag) {
  return tag;
}

// Return first index of any phrase from list in `hay` (already lowercased). Infinity if none.
function firstIndexOfAny(hay, phrases) {
  let pos = Infinity;
  for (const p of phrases) {
    const i = hay.indexOf(p);
    if (i !== -1 && i < pos) pos = i;
  }
  return pos;
}

// Find approximate index of a hashtag in text.
function findHashtagIndex(text, tag) {
  const lower = text.toLowerCase();
  const candidates = [
    "#" + tag.toLowerCase(),
    "#" + tag.toLowerCase().replace(/\s+/g, "_"),
  ];
  let best = -1;
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

// Extract links & mentions from entities
function extractLinks(t) {
  return (t.entities?.urls || []).map(u => u.expanded_url || u.url).filter(Boolean);
}
function extractMentions(t) {
  return (t.entities?.mentions || []).map(m => "@" + m.username);
}

// Core: classify hashtags into source vs destination
function classifyPlaces(text, hashtags) {
  const lower = text.toLowerCase();

  const SOURCE_PHRASES = ["βρίσκεστε", "στην περιοχή", "στις περιοχές", "if you are in"];
  const DEST_PHRASES = ["απομακρυνθείτε προς", "απομακρυνθείτε", "κατευθυνθείτε προς", "move away to", "head towards"];

  const srcStart = firstIndexOfAny(lower, SOURCE_PHRASES);
  const dstStart = firstIndexOfAny(lower, DEST_PHRASES);

  const source = [];
  const destination = [];
  const regional_units = [];

  for (const tag of hashtags) {
    const idx = findHashtagIndex(text, tag);
    if (idx === -1) {
      source.push(normaliseTag(tag));
      continue;
    }

    // 🟢 Detect "Περιφερειακή Ενότητα" immediately before the hashtag
    const context = text.substring(Math.max(0, idx - 40), idx).toLowerCase();
    if (context.includes("περιφερειακή ενότητα")) {
      regional_units.push(normaliseTag(tag));
      continue; // don't classify this tag as source/destination
    }

    const tagClean = normaliseTag(tag);

    if (dstStart !== Infinity && idx >= dstStart) {
      destination.push(tagClean);
    } else if (srcStart !== Infinity && idx >= srcStart && idx < dstStart) {
      source.push(tagClean);
    } else {
      if (dstStart !== Infinity && srcStart === Infinity) {
        destination.push(tagClean);
      } else {
        source.push(tagClean);
      }
    }
  }

  return {
    source: uniquePreserveOrder(source),
    destination: uniquePreserveOrder(destination),
    regional_units: uniquePreserveOrder(regional_units),
  };
}

// Extract geo.place_id if available
function extractGeoPlaceId(t) {
  return t.geo?.place_id || null;
}

// --- transform ---
const alerts = tweets.map(t => {
  const links = extractLinks(t);
  const mentions = extractMentions(t);
  const hashtags = (t.entities?.hashtags || []).map(h => h.tag).filter(Boolean);

  const places = classifyPlaces(t.text || "", hashtags);
  const place_id = extractGeoPlaceId(t);

  const out = {
    timestamp: t.created_at || null,
    language: detectLang(t.text || ""),
    message: t.text || "",
    links,
    mentions,
    places, // { source: [...], destination: [...], regional_units: [...] }
  };
  if (place_id) out.place_id = place_id;

  return out;
});

// Write output
fs.writeFileSync(OUTPUT, JSON.stringify(alerts, null, 2), "utf-8");
console.log(`Saved ${alerts.length} alerts to ${OUTPUT}`);
