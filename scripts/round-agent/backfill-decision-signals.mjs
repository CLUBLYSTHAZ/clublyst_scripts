import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const SOURCE_VERSION = "round_agent_decision_signals_v2";
const DEFAULT_CHUNK_SIZE = 250;

const CONFIDENCE = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

const SIGNAL_CONTEXT_GLOBAL = "global";

const LONDON_ORIGINS = {
  south_west_london: { lat: 51.4309, lon: -0.1967, label: "South West London" },
  west_london: { lat: 51.5074, lon: -0.3064, label: "West London" },
  south_london: { lat: 51.4452, lon: -0.0702, label: "South London" },
  north_london: { lat: 51.5898, lon: -0.1237, label: "North London" },
  east_london: { lat: 51.545, lon: 0.0288, label: "East London" },
  central_london: { lat: 51.5072, lon: -0.1276, label: "Central London" },
};

const ACCESS_CORRIDORS_BY_COUNTY = {
  surrey: ["surrey_corridor", "south_west_london", "south_london"],
  berkshire: ["berkshire_corridor", "west_london", "south_west_london"],
  hampshire: ["hampshire_corridor", "south_west_london", "west_london"],
  "west sussex": ["west_sussex_corridor", "south_london", "south_west_london"],
  kent: ["kent_corridor", "south_london", "east_london"],
  essex: ["essex_corridor", "east_london"],
  hertfordshire: ["hertfordshire_corridor", "north_london"],
  "greater london": [
    "central_london",
    "south_west_london",
    "west_london",
    "south_london",
    "north_london",
    "east_london",
  ],
  london: [
    "central_london",
    "south_west_london",
    "west_london",
    "south_london",
    "north_london",
    "east_london",
  ],
};

function parseArgs(argv) {
  const options = {
    dryRun: false,
    clubName: null,
    sourceFile: "src/data/clubs-enriched.json",
    summaryFile: "round-agent-decision-signals-summary.json",
    chunkSize: DEFAULT_CHUNK_SIZE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--club") {
      options.clubName = normalizeNullableText(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--source") {
      options.sourceFile = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--summary") {
      options.summaryFile = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--chunk-size") {
      const chunkSize = Number(argv[index + 1]);
      if (Number.isInteger(chunkSize) && chunkSize > 0) {
        options.chunkSize = chunkSize;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readJson(filePath, fallback = null) {
  const absolute = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolute)) return fallback;
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function normalizeNullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (["n/a", "na", "null", "undefined", "-"].includes(normalized)) return null;
  return text;
}

function normalizeClubKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(the|golf and country club|golf club|country club|golf course|golf centre|golf center|gc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parsePayPlayRange(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const nums = text.replace(/,/g, "").match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  const finite = nums.filter((num) => Number.isFinite(num) && num > 0);
  if (!finite.length) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return { min, max, avg: (min + max) / 2, raw: text };
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function haversineKm(from, to) {
  const earthKm = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inferBookingProvider(url) {
  try {
    if (!url) return "unknown";
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const full = parsed.toString().toLowerCase();
    if (host.includes("brsgolf.com")) return "brs";
    if (host.includes("clubv1.com")) return "clubv1";
    if (host.includes("intelligentgolf") || host.includes("clubsystems.co.uk")) return "intelligentgolf";
    if (host.includes("golfnow")) return "golfnow";
    if (host.includes("teeitup") || host.includes("teebooking")) return "teeitup";
    if (host.includes("foretees")) return "foretees";
    if (host.includes("golfgraffix")) return "golfgraffix";
    if (host.includes("e-s-p.com") || host.includes("espgolf") || host.includes("esp.golf")) return "esp";
    if (host.includes("premiersoftware.co.uk")) return "premier";
    if (pathname.includes("visitorbooking") || full.includes("visitor_booking")) return "intelligentgolf";
    if (pathname.includes("/visitors/booking") || pathname.includes("/visitors/teesheet")) return "clubv1";
    if (host.includes("club") || host.includes("golf")) return "club_site";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function providerScore(provider, hasUrl) {
  if (!hasUrl) return 0;
  if (["brs", "clubv1", "intelligentgolf"].includes(provider)) return 88;
  if (["golfnow", "teeitup", "foretees", "golfgraffix", "esp", "premier"].includes(provider)) return 78;
  if (provider === "club_site") return 68;
  return 55;
}

function loadBookingUrls() {
  const rows = readJson("src/data/London Golf Memberships - Booking URLs.json", []);
  const map = new Map();
  for (const row of rows || []) {
    const name = normalizeNullableText(row?.["Club name"] ?? row?.["Club Name"]);
    const url = normalizeNullableText(row?.["Booking URL"] ?? row?.bookingUrl);
    if (!name || !url || url.toLowerCase() === "call to book") continue;
    map.set(normalizeClubKey(name), url);
  }
  return map;
}

function loadPlayability() {
  const playability = readJson("src/data/club_playability.json", { clubs: [] });
  const shortCourses = readJson("src/data/short-courses-enriched.json", []);
  const map = new Map();

  for (const row of playability?.clubs || []) {
    const key = normalizeClubKey(row?.name);
    if (!key) continue;
    map.set(key, {
      holes: parseNumber(row?.holes),
      lengthBand: normalizeKnown(row?.lengthBand, ["short", "medium", "long"]),
      difficulty: normalizeKnown(row?.difficulty, ["easy", "moderate", "hard"]),
      source: "club_playability",
    });
  }

  for (const row of shortCourses || []) {
    const key = normalizeClubKey(row?.["Club Name"]);
    if (!key || map.has(key)) continue;
    const play = row?.coursePlayability || {};
    map.set(key, {
      holes: parseNumber(play?.holes),
      lengthBand: normalizeKnown(play?.lengthBand, ["short", "medium", "long"]),
      difficulty: normalizeKnown(play?.difficulty, ["easy", "moderate", "hard"]),
      source: "short_courses_enriched",
    });
  }

  return map;
}

function normalizeKnown(value, allowed) {
  const text = String(value || "").toLowerCase().trim();
  return allowed.includes(text) ? text : null;
}

function loadConditions() {
  const rows = readJson("src/data/course-conditions-live.json", {});
  const map = new Map();
  for (const [key, row] of Object.entries(rows || {})) {
    const normalizedKey = normalizeClubKey(row?.club_name || key);
    if (!normalizedKey) continue;
    map.set(normalizedKey, row);
  }
  return map;
}

function groupClubRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = normalizeNullableText(row?.["Club Name"]);
    const key = normalizeClubKey(name);
    if (!name || !key) continue;
    if (!map.has(key)) {
      map.set(key, {
        key,
        clubName: name,
        county: normalizeNullableText(row?.["Location (County)"]),
        postcode: normalizeNullableText(row?.Postcode),
        latitude: parseNumber(row?.latitude),
        longitude: parseNumber(row?.longitude),
        top100London: row?.top100London === true,
        rows: [],
      });
    }
    const club = map.get(key);
    club.rows.push(row);
    if (!club.county) club.county = normalizeNullableText(row?.["Location (County)"]);
    if (!club.postcode) club.postcode = normalizeNullableText(row?.Postcode);
    if (club.latitude === null) club.latitude = parseNumber(row?.latitude);
    if (club.longitude === null) club.longitude = parseNumber(row?.longitude);
    if (row?.top100London === true) club.top100London = true;
  }
  return map;
}

function buildCountyPriceStats(clubsByKey) {
  const byCounty = new Map();
  for (const club of clubsByKey.values()) {
    const price = derivePrice(club);
    const county = String(club.county || "").toLowerCase().trim();
    if (!county || !price) continue;
    const arr = byCounty.get(county) || [];
    arr.push(price.avg);
    byCounty.set(county, arr);
  }
  const stats = new Map();
  for (const [county, values] of byCounty.entries()) {
    stats.set(county, {
      median: median(values),
      sample: values.length,
    });
  }
  return stats;
}

function derivePrice(club) {
  const ranges = club.rows
    .map((row) => parsePayPlayRange(row?.["Pay & Play"]))
    .filter(Boolean);
  if (!ranges.length) return null;
  const min = Math.min(...ranges.map((range) => range.min));
  const max = Math.max(...ranges.map((range) => range.max));
  return {
    min,
    max,
    avg: (min + max) / 2,
    raw_values: Array.from(new Set(ranges.map((range) => range.raw))),
  };
}

function freshnessFromUpdatedAt(updatedAt, freshDays, staleDays) {
  if (!updatedAt) return "unknown";
  const time = Date.parse(updatedAt);
  if (!Number.isFinite(time)) return "unknown";
  const ageDays = (Date.now() - time) / (24 * 60 * 60 * 1000);
  if (ageDays <= freshDays) return "fresh";
  if (ageDays >= staleDays) return "stale";
  return "unknown";
}

function isFreshTimestamp(timestamp, maxHours = 28) {
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= maxHours * 60 * 60 * 1000;
}

function wetWeatherScore(condition) {
  if (!condition) return null;
  const drainage = String(condition.drainage_bucket || condition.estimated_drainage_bucket || "").toUpperCase();
  const label = String(condition.condition_label || "").toLowerCase();
  let score = 50;
  if (drainage === "D1") score += 24;
  else if (drainage === "D2") score += 14;
  else if (drainage === "D3") score -= 6;
  else if (drainage === "D4") score -= 18;
  if (label.includes("good") || label.includes("playable")) score += 10;
  if (label.includes("tough") || label.includes("poor")) score -= 18;
  return clamp(score);
}

function categorical(value, strongAt = 75, weakBelow = 45) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= strongAt) return "strong";
  if (value < weakBelow) return "weak";
  return "medium";
}

function parseTeeTimeMs(row) {
  const direct = Date.parse(row?.tee_time_at);
  if (Number.isFinite(direct)) return direct;

  const localDate = String(row?.local_date || row?.date || "").trim();
  const localTime = String(row?.local_time || row?.tee_time || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
  const timeMatch = localTime.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(am|pm)?$/i);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = String(timeMatch[3] || "").toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return Date.parse(
    `${localDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+01:00`
  );
}

function buildTeeTimeMetrics(rows) {
  const futureRows = (rows || []).filter((row) => {
    const teeTime = parseTeeTimeMs(row);
    return Number.isFinite(teeTime) && teeTime >= Date.now();
  });
  if (!futureRows.length) return null;

  const maxScrapedAt = futureRows
    .map((row) => Date.parse(row?.scraped_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const lastScrapedAt = Number.isFinite(maxScrapedAt) ? new Date(maxScrapedAt).toISOString() : null;
  const freshRows = futureRows.filter((row) => isFreshTimestamp(row?.scraped_at));
  const rowsForSignals = freshRows.length ? freshRows : futureRows;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const next3 = rowsForSignals.filter((row) => parseTeeTimeMs(row) <= now + 3 * dayMs);
  const next7 = rowsForSignals.filter((row) => parseTeeTimeMs(row) <= now + 7 * dayMs);
  const weekendRows = next7.filter((row) => Number(row?.local_dow) === 0 || Number(row?.local_dow) === 6);
  const knownSpotRows = next7.filter((row) => Number.isFinite(Number(row?.spots_available)));
  const fourballRows = knownSpotRows.filter((row) => Number(row?.spots_available) >= 4);
  const weekendFourballRows = fourballRows.filter((row) => Number(row?.local_dow) === 0 || Number(row?.local_dow) === 6);
  const uniqueWeekendDays = new Set(weekendRows.map((row) => String(row?.local_date || "")));

  return {
    hasData: rowsForSignals.length > 0,
    isFresh: freshRows.length > 0,
    lastScrapedAt,
    slotsNext3Days: next3.length,
    slotsNext7Days: next7.length,
    weekendSlotsNext7Days: weekendRows.length,
    weekendDaysWithSlots: Array.from(uniqueWeekendDays).filter(Boolean).length,
    knownSpotRows: knownSpotRows.length,
    fourballSlotsNext7Days: fourballRows.length,
    weekendFourballSlotsNext7Days: weekendFourballRows.length,
    hasMorningSlots: next7.some((row) => String(row?.local_time || "") >= "06:00" && String(row?.local_time || "") < "12:00"),
    hasAfternoonSlots: next7.some((row) => String(row?.local_time || "") >= "12:00" && String(row?.local_time || "") <= "17:30"),
    hasEveningSlots: next7.some((row) => String(row?.local_time || "") > "17:30"),
  };
}

function parseRawTeeTimeAt(row) {
  const dateText = String(row?.date || "").trim();
  const timeText = String(row?.tee_time || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const timeMatch = timeText.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(am|pm)?$/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = String(timeMatch[3] || "").toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const normalizedTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  return `${dateText}T${normalizedTime}+01:00`;
}

function normalizeRawTeeTimeRow(row, clubId) {
  const teeTimeAt = parseRawTeeTimeAt(row);
  if (!teeTimeAt) return null;
  const localDate = String(row?.date || "").trim();
  const localTime = String(row?.tee_time || "").trim().slice(0, 5).padStart(5, "0");
  const localDow = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return {
    club_id: clubId,
    tee_time_at: teeTimeAt,
    local_date: localDate,
    local_time: localTime,
    local_dow: localDow,
    spots_available: row?.spots_available,
    scraped_at: row?.scraped_at || row?.updated_at || null,
  };
}

function availabilityScore(metrics) {
  if (!metrics?.hasData) return null;
  if (!metrics.isFresh) return 30;
  return clamp(42 + Math.min(36, metrics.slotsNext3Days * 3) + Math.min(12, metrics.slotsNext7Days));
}

function weekendAvailabilityScore(metrics) {
  if (!metrics?.hasData) return null;
  if (!metrics.isFresh) return 28;
  if (!metrics.weekendSlotsNext7Days) return 25;
  return clamp(45 + Math.min(35, metrics.weekendSlotsNext7Days * 4) + Math.min(15, metrics.weekendDaysWithSlots * 7.5));
}

function fourballScore(metrics) {
  if (!metrics?.hasData) return null;
  if (!metrics.isFresh) return 28;
  if (metrics.knownSpotRows > 0) {
    if (metrics.fourballSlotsNext7Days > 0) {
      return clamp(58 + Math.min(32, metrics.fourballSlotsNext7Days * 8));
    }
    return 30;
  }
  if (metrics.weekendSlotsNext7Days >= 8 || metrics.slotsNext7Days >= 18) return 62;
  if (metrics.weekendSlotsNext7Days > 0 || metrics.slotsNext7Days >= 8) return 52;
  return 35;
}

function paceProxyScore(metrics) {
  if (!metrics?.hasData) return null;
  if (!metrics.isFresh) return 30;
  const weekendDepth = metrics.weekendSlotsNext7Days;
  const totalDepth = metrics.slotsNext7Days;
  if (weekendDepth >= 10 || totalDepth >= 28) return 78;
  if (weekendDepth >= 4 || totalDepth >= 14) return 64;
  if (weekendDepth > 0 || totalDepth >= 6) return 50;
  return 35;
}

function lengthScore(play) {
  if (!play) return null;
  if (play.lengthBand === "long") return 92;
  if (play.lengthBand === "medium" && play.holes >= 18) return 68;
  if (play.lengthBand === "short" && play.holes >= 18) return 42;
  if (play.holes >= 18) return 58;
  if (play.holes === 9) return 18;
  return null;
}

function full18Score(play) {
  if (!play?.holes) return null;
  if (play.holes >= 18) return 95;
  if (play.holes === 9) return 35;
  return 50;
}

function beginnerScore(play) {
  if (!play) return null;
  let score = 50;
  if (play.difficulty === "easy") score += 32;
  if (play.difficulty === "moderate") score += 8;
  if (play.difficulty === "hard") score -= 28;
  if (play.lengthBand === "short") score += 12;
  if (play.lengthBand === "long") score -= 10;
  if (play.holes === 9) score += 8;
  return clamp(score);
}

function difficultyScore(play) {
  if (!play?.difficulty) return null;
  if (play.difficulty === "easy") return 78;
  if (play.difficulty === "moderate") return 68;
  if (play.difficulty === "hard") return 58;
  return null;
}

function valueScore({ price, condition, play, countyStats, top100London }) {
  if (!price) return null;
  let score = 52;
  const medianValue = countyStats?.median;
  if (Number.isFinite(medianValue) && medianValue > 0) {
    const ratio = price.avg / medianValue;
    if (ratio <= 0.7) score += 30;
    else if (ratio <= 0.9) score += 18;
    else if (ratio <= 1.1) score += 6;
    else if (ratio >= 1.45) score -= 20;
    else if (ratio >= 1.2) score -= 8;
  }
  const conditionScore = parseNumber(condition?.condition_score_10);
  if (conditionScore !== null) score += (conditionScore - 5) * 3;
  if (play?.holes >= 18) score += 5;
  if (play?.lengthBand === "long") score += 5;
  if (top100London) score += 8;
  return clamp(score);
}

function inferAccessCorridors(club) {
  const county = String(club.county || "").toLowerCase().trim();
  const base = ACCESS_CORRIDORS_BY_COUNTY[county] || [];
  const corridors = new Set(base);
  if (club.latitude !== null && club.longitude !== null) {
    if (club.longitude < -0.25) corridors.add("west_london");
    if (club.longitude < -0.1 && club.latitude < 51.52) corridors.add("south_west_london");
    if (club.longitude > 0.05) corridors.add("east_london");
    if (club.latitude > 51.55) corridors.add("north_london");
    if (club.latitude < 51.45) corridors.add("south_london");
  }
  return Array.from(corridors);
}

function accessFitScore(club, originKey) {
  const origin = LONDON_ORIGINS[originKey];
  if (!origin || club.latitude === null || club.longitude === null) return null;
  const km = haversineKm(origin, { lat: club.latitude, lon: club.longitude });
  let score = 100 - Math.min(km, 85) * 0.95;
  const county = String(club.county || "").toLowerCase().trim();
  if (originKey === "south_west_london") {
    if (["surrey", "berkshire", "hampshire", "west sussex"].includes(county)) score += 14;
    if (["hertfordshire", "essex"].includes(county)) score -= 28;
    if (club.latitude > 51.55) score -= 18;
    if (club.longitude > 0.05) score -= 18;
  }
  if (originKey === "west_london" && ["berkshire", "surrey", "hampshire"].includes(county)) score += 10;
  if (originKey === "east_london" && ["essex", "kent"].includes(county)) score += 10;
  if (originKey === "north_london" && ["hertfordshire"].includes(county)) score += 12;
  return clamp(score);
}

function makeSignal(clubId, signalKey, signalValue, options = {}) {
  return {
    club_id: clubId,
    signal_key: signalKey,
    signal_context: options.signalContext || SIGNAL_CONTEXT_GLOBAL,
    signal_value: signalValue,
    signal_score: Number.isFinite(options.signalScore) ? Number(options.signalScore.toFixed(2)) : null,
    confidence: options.confidence || CONFIDENCE.MEDIUM,
    evidence: options.evidence || {},
    signal_payload: options.signalPayload || {},
    source_type: options.sourceType || "derived",
    source_version: SOURCE_VERSION,
    source_updated_at: options.sourceUpdatedAt || null,
    generated_by: options.generatedBy || "round_agent_backfill",
    generated_at: new Date().toISOString(),
    review_status: options.reviewStatus || "auto_approved",
  };
}

function addSignal(signals, signal) {
  if (!signal) return;
  signals.push(signal);
}

function deriveClubSignals({ clubId, club, bookingUrl, play, condition, price, countyStats, teeTimeMetrics }) {
  const signals = [];
  const bookingProvider = inferBookingProvider(bookingUrl);
  const bookingScore = providerScore(bookingProvider, !!bookingUrl);
  const accessCorridors = inferAccessCorridors(club);

  addSignal(
    signals,
    makeSignal(clubId, "booking_route_confidence", categorical(bookingScore), {
      signalScore: bookingScore,
      confidence: bookingUrl ? CONFIDENCE.HIGH : CONFIDENCE.LOW,
      evidence: { booking_url_known: !!bookingUrl, booking_provider: bookingProvider },
      sourceType: "booking",
    })
  );

  for (const corridor of accessCorridors) {
    addSignal(
      signals,
      makeSignal(clubId, "access_corridor", corridor, {
        signalContext: corridor,
        signalScore: 80,
        confidence: CONFIDENCE.MEDIUM,
        evidence: { county: club.county, latitude: club.latitude, longitude: club.longitude },
      })
    );
  }

  for (const originKey of Object.keys(LONDON_ORIGINS)) {
    const score = accessFitScore(club, originKey);
    if (score === null) continue;
    addSignal(
      signals,
      makeSignal(clubId, "access_fit", categorical(score), {
        signalContext: originKey,
        signalScore: score,
        confidence: CONFIDENCE.MEDIUM,
        evidence: {
          origin: LONDON_ORIGINS[originKey].label,
          county: club.county,
          latitude: club.latitude,
          longitude: club.longitude,
          model: "london_access_v1",
        },
      })
    );
  }

  const longScore = lengthScore(play);
  if (longScore !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "long_course_fit", categorical(longScore), {
        signalScore: longScore,
        confidence: CONFIDENCE.HIGH,
        evidence: { holes: play?.holes, length_band: play?.lengthBand, source: play?.source },
        sourceType: "course_enrichment",
      })
    );
  }

  const fullScore = full18Score(play);
  if (fullScore !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "full_18_fit", categorical(fullScore), {
        signalScore: fullScore,
        confidence: CONFIDENCE.HIGH,
        evidence: { holes: play?.holes, source: play?.source },
        sourceType: "course_enrichment",
      })
    );
  }

  const beginner = beginnerScore(play);
  if (beginner !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "beginner_friendly", categorical(beginner), {
        signalScore: beginner,
        confidence: CONFIDENCE.MEDIUM,
        evidence: {
          holes: play?.holes,
          length_band: play?.lengthBand,
          difficulty: play?.difficulty,
          source: play?.source,
        },
        sourceType: "course_enrichment",
      })
    );
  }

  const difficulty = difficultyScore(play);
  if (difficulty !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "difficulty_fit", play?.difficulty || "unknown", {
        signalScore: difficulty,
        confidence: CONFIDENCE.HIGH,
        evidence: { difficulty: play?.difficulty, source: play?.source },
        sourceType: "course_enrichment",
      })
    );
  }

  const wetScore = wetWeatherScore(condition);
  if (wetScore !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "wet_weather_fit", categorical(wetScore), {
        signalScore: wetScore,
        confidence: condition?.estimated_drainage_bucket ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH,
        evidence: {
          condition_label: condition?.condition_label,
          condition_score_10: condition?.condition_score_10,
          drainage_bucket: condition?.drainage_bucket,
          estimated_drainage_bucket: condition?.estimated_drainage_bucket,
          updated_at: condition?.updated_at,
        },
        sourceType: "conditions",
        sourceUpdatedAt: condition?.updated_at || null,
      })
    );
  }

  const value = valueScore({ price, condition, play, countyStats, top100London: club.top100London });
  if (value !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "value_fit", categorical(value), {
        signalScore: value,
        confidence: countyStats?.median ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
        evidence: {
          price_min: price?.min,
          price_max: price?.max,
          price_avg: price?.avg,
          county_median: countyStats?.median || null,
          county_sample: countyStats?.sample || 0,
          condition_score_10: condition?.condition_score_10 ?? null,
          length_band: play?.lengthBand ?? null,
          top100_london: club.top100London,
        },
        sourceType: "pricing",
      })
    );
  }

  const availability = availabilityScore(teeTimeMetrics);
  if (availability !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "availability_confidence", categorical(availability), {
        signalScore: availability,
        confidence: teeTimeMetrics?.isFresh ? CONFIDENCE.HIGH : CONFIDENCE.LOW,
        evidence: {
          slots_next_3_days: teeTimeMetrics?.slotsNext3Days,
          slots_next_7_days: teeTimeMetrics?.slotsNext7Days,
          last_scraped_at: teeTimeMetrics?.lastScrapedAt,
          freshness_window_hours: 28,
        },
        sourceType: "tee_times",
        sourceUpdatedAt: teeTimeMetrics?.lastScrapedAt || null,
      })
    );
  }

  const weekendAvailability = weekendAvailabilityScore(teeTimeMetrics);
  if (weekendAvailability !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "weekend_availability_fit", categorical(weekendAvailability), {
        signalScore: weekendAvailability,
        confidence: teeTimeMetrics?.isFresh ? CONFIDENCE.HIGH : CONFIDENCE.LOW,
        evidence: {
          weekend_slots_next_7_days: teeTimeMetrics?.weekendSlotsNext7Days,
          weekend_days_with_slots: teeTimeMetrics?.weekendDaysWithSlots,
          last_scraped_at: teeTimeMetrics?.lastScrapedAt,
          freshness_window_hours: 28,
        },
        sourceType: "tee_times",
        sourceUpdatedAt: teeTimeMetrics?.lastScrapedAt || null,
      })
    );
  }

  const fourball = fourballScore(teeTimeMetrics);
  if (fourball !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "fourball_fit", categorical(fourball), {
        signalScore: fourball,
        confidence:
          teeTimeMetrics?.isFresh && teeTimeMetrics?.knownSpotRows > 0
            ? CONFIDENCE.HIGH
            : teeTimeMetrics?.isFresh
              ? CONFIDENCE.MEDIUM
              : CONFIDENCE.LOW,
        evidence: {
          known_spot_rows: teeTimeMetrics?.knownSpotRows,
          fourball_slots_next_7_days: teeTimeMetrics?.fourballSlotsNext7Days,
          weekend_fourball_slots_next_7_days: teeTimeMetrics?.weekendFourballSlotsNext7Days,
          slots_next_7_days: teeTimeMetrics?.slotsNext7Days,
          last_scraped_at: teeTimeMetrics?.lastScrapedAt,
          proxy_used: !teeTimeMetrics?.knownSpotRows,
        },
        sourceType: "tee_times",
        sourceUpdatedAt: teeTimeMetrics?.lastScrapedAt || null,
      })
    );
  }

  const pace = paceProxyScore(teeTimeMetrics);
  if (pace !== null) {
    addSignal(
      signals,
      makeSignal(clubId, "pace_of_play_proxy", categorical(pace), {
        signalScore: pace,
        confidence: teeTimeMetrics?.isFresh ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
        evidence: {
          slots_next_7_days: teeTimeMetrics?.slotsNext7Days,
          weekend_slots_next_7_days: teeTimeMetrics?.weekendSlotsNext7Days,
          weekend_days_with_slots: teeTimeMetrics?.weekendDaysWithSlots,
          last_scraped_at: teeTimeMetrics?.lastScrapedAt,
          caveat: "Availability depth is a proxy for flexibility/crowding, not measured pace of play.",
        },
        sourceType: "tee_times",
        sourceUpdatedAt: teeTimeMetrics?.lastScrapedAt || null,
      })
    );
  }

  return signals;
}

function deriveEnrichment(clubId, club, signals) {
  const byKey = new Map(signals.map((signal) => [`${signal.signal_key}:${signal.signal_context}`, signal]));
  const globalByKey = new Map(
    signals
      .filter((signal) => signal.signal_context === SIGNAL_CONTEXT_GLOBAL)
      .map((signal) => [signal.signal_key, signal])
  );
  const roundFitTags = [];
  const strengths = [];
  const tradeoffs = [];
  const bestFor = [];
  const avoidIf = [];
  const accessCorridors = signals
    .filter((signal) => signal.signal_key === "access_corridor")
    .map((signal) => signal.signal_value);

  const long = globalByKey.get("long_course_fit");
  const full18 = globalByKey.get("full_18_fit");
  const beginner = globalByKey.get("beginner_friendly");
  const wet = globalByKey.get("wet_weather_fit");
  const value = globalByKey.get("value_fit");
  const availability = globalByKey.get("availability_confidence");
  const weekendAvailability = globalByKey.get("weekend_availability_fit");
  const fourball = globalByKey.get("fourball_fit");
  const pace = globalByKey.get("pace_of_play_proxy");

  if (long?.signal_value === "strong") {
    roundFitTags.push("long_course");
    strengths.push("long_course_fit");
    bestFor.push("longer_round");
  }
  if (full18?.signal_value === "strong") roundFitTags.push("full_18");
  if (beginner?.signal_value === "strong") {
    roundFitTags.push("beginner_friendly");
    bestFor.push("newer_golfers");
  }
  if (wet?.signal_value === "strong") {
    roundFitTags.push("wet_weather_option");
    strengths.push("wet_weather_fit");
  }
  if (value?.signal_value === "strong") {
    roundFitTags.push("value_round");
    strengths.push("strong_value");
  }
  if (availability?.signal_value === "strong") {
    roundFitTags.push("good_availability");
    strengths.push("fresh_tee_time_availability");
  }
  if (weekendAvailability?.signal_value === "strong") {
    roundFitTags.push("weekend_availability");
    strengths.push("weekend_availability_fit");
  }
  if (fourball?.signal_value === "strong") {
    roundFitTags.push("fourball_friendly");
    bestFor.push("group_of_four");
  }
  if (pace?.signal_value === "strong") {
    roundFitTags.push("availability_depth");
    strengths.push("pace_proxy_positive");
  }

  const swAccess = byKey.get("access_fit:south_west_london");
  if (swAccess?.signal_value === "strong") strengths.push("south_west_london_access");
  if (swAccess?.signal_value === "weak") tradeoffs.push("weaker_south_west_london_access");

  if (globalByKey.get("booking_route_confidence")?.signal_value === "weak") {
    tradeoffs.push("booking_route_less_clear");
  }
  if (wet?.confidence === CONFIDENCE.LOW) tradeoffs.push("conditions_signal_low_confidence");
  if (value?.confidence === CONFIDENCE.LOW) tradeoffs.push("value_signal_low_confidence");
  if (!availability) tradeoffs.push("tee_time_availability_missing");
  if (pace?.confidence === CONFIDENCE.LOW) tradeoffs.push("pace_signal_low_confidence");

  const lowSignals = signals.filter((signal) => signal.confidence === CONFIDENCE.LOW).length;
  const highSignals = signals.filter((signal) => signal.confidence === CONFIDENCE.HIGH).length;
  const dataConfidence = lowSignals >= 3 ? CONFIDENCE.LOW : highSignals >= 3 ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM;
  const needsReview = lowSignals >= 4;

  return {
    club_id: clubId,
    round_fit_tags: Array.from(new Set(roundFitTags)),
    decision_strengths: Array.from(new Set(strengths)),
    tradeoff_flags: Array.from(new Set(tradeoffs)),
    access_corridors: Array.from(new Set(accessCorridors)),
    best_for: Array.from(new Set(bestFor)),
    avoid_if: Array.from(new Set(avoidIf)),
    agent_summary: null,
    summary_confidence: dataConfidence,
    data_confidence: dataConfidence,
    needs_review: needsReview,
    review_reason: needsReview ? "Multiple low-confidence decision signals" : null,
    review_status: needsReview ? "needs_review" : "auto_approved",
    source_version: SOURCE_VERSION,
    generated_by: "round_agent_backfill",
    generated_at: new Date().toISOString(),
  };
}

function deriveDataQuality(clubId, { club, bookingUrl, play, condition, price, signals, teeTimeMetrics }) {
  const freshness = {
    condition: freshnessFromUpdatedAt(condition?.updated_at, 7, 14),
    teeTime: teeTimeMetrics?.isFresh ? "fresh" : teeTimeMetrics?.hasData ? "stale" : "unknown",
    price: "unknown",
    booking: bookingUrl ? "unknown" : null,
  };
  const missing = [];
  const stale = [];
  if (!price) missing.push("price");
  if (!signals.some((signal) => signal.signal_key === "value_fit")) missing.push("value_signal");
  if (!condition) missing.push("conditions");
  if (!play?.difficulty) missing.push("difficulty");
  if (!bookingUrl) missing.push("booking");
  if (club.latitude === null || club.longitude === null) missing.push("location");
  if (!signals.some((signal) => signal.signal_key === "access_fit")) missing.push("access_signal");
  if (!signals.some((signal) => signal.signal_key === "fourball_fit")) missing.push("group_signal");
  if (!signals.some((signal) => signal.signal_key === "pace_of_play_proxy")) missing.push("pace_signal");
  if (!signals.some((signal) => signal.signal_key === "availability_confidence")) missing.push("availability_signal");
  if (freshness.condition === "stale") stale.push("conditions");
  if (freshness.teeTime === "stale") stale.push("tee_times");

  const hasCore = price && condition && play?.difficulty && bookingUrl && club.latitude !== null && club.longitude !== null;
  const overall =
    missing.length <= 2 && hasCore
      ? CONFIDENCE.HIGH
      : missing.length <= 5
        ? CONFIDENCE.MEDIUM
        : CONFIDENCE.LOW;

  return {
    club_id: clubId,
    has_price_data: !!price,
    has_value_signal: signals.some((signal) => signal.signal_key === "value_fit"),
    has_conditions_data: !!condition,
    has_difficulty_data: !!play?.difficulty,
    has_booking_data: !!bookingUrl,
    has_location_data: club.latitude !== null && club.longitude !== null,
    has_tee_time_data: !!teeTimeMetrics?.hasData,
    has_access_signal: signals.some((signal) => signal.signal_key === "access_fit"),
    has_group_signal: signals.some((signal) => signal.signal_key === "fourball_fit"),
    has_pace_signal: signals.some((signal) => signal.signal_key === "pace_of_play_proxy"),
    condition_freshness: freshness.condition,
    tee_time_freshness: freshness.teeTime,
    price_freshness: freshness.price,
    booking_freshness: freshness.booking,
    overall_data_confidence: overall,
    missing_decision_fields: missing,
    stale_decision_fields: stale,
    quality_notes: {
      missing_count: missing.length,
      stale_count: stale.length,
      deterministic_backfill: true,
      tee_time_metrics: teeTimeMetrics || null,
      premium_proxy_signals_pending: teeTimeMetrics?.hasData ? [] : ["fourball_fit", "weekend_capacity_proxy", "pace_of_play_proxy"],
    },
    generated_by: "round_agent_backfill",
    generated_at: new Date().toISOString(),
  };
}

async function fetchSupabaseClubs(supabase) {
  const { data, error } = await supabase.from("clubs").select("id, club_name");
  if (error) throw new Error(`Failed to fetch clubs: ${error.message}`);
  return data || [];
}

async function fetchAllRows(supabase, table, select, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase.from(table).select(select).range(from, to);
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function fetchTeeTimeMetricsByClub(supabase, supabaseClubs) {
  const diagnostics = {
    source: "clublyst_tee_times_resolved",
    resolved_rows: 0,
    raw_rows: 0,
    matched_raw_rows: 0,
    clubs_with_metrics: 0,
    fallback_used: false,
  };

  let rows = await fetchAllRows(
    supabase,
    "clublyst_tee_times_resolved",
    "club_id, tee_time_at, local_date, local_time, local_dow, spots_available, scraped_at"
  );

  diagnostics.resolved_rows = rows.length;

  if (!rows.length) {
    diagnostics.source = "tee_times";
    diagnostics.fallback_used = true;
    const clubIdsByKey = new Map(
      (supabaseClubs || []).map((club) => [normalizeClubKey(club.club_name), String(club.id)])
    );
    const rawRows = await fetchAllRows(
      supabase,
      "tee_times",
      "course_name, date, tee_time, spots_available, scraped_at, updated_at"
    );
    diagnostics.raw_rows = rawRows.length;
    rows = rawRows
      .map((row) => {
        const clubId = clubIdsByKey.get(normalizeClubKey(row?.course_name));
        if (!clubId) return null;
        return normalizeRawTeeTimeRow(row, clubId);
      })
      .filter(Boolean);
    diagnostics.matched_raw_rows = rows.length;
  }

  const rowsByClubId = new Map();
  for (const row of rows) {
    const clubId = String(row?.club_id || "");
    if (!clubId) continue;
    if (!rowsByClubId.has(clubId)) rowsByClubId.set(clubId, []);
    rowsByClubId.get(clubId).push(row);
  }
  const metricsByClub = new Map(
    Array.from(rowsByClubId.entries()).map(([clubId, clubRows]) => [
      clubId,
      buildTeeTimeMetrics(clubRows),
    ])
  );
  diagnostics.clubs_with_metrics = metricsByClub.size;
  diagnostics.clubs_with_usable_metrics = Array.from(metricsByClub.values()).filter(Boolean).length;
  return { metricsByClub, diagnostics };
}

async function upsertInChunks(supabase, table, rows, options = {}) {
  if (!rows.length) return { rows: 0 };
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  let total = 0;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const query = supabase.from(table).upsert(chunk, options.upsertOptions || {});
    const { error } = await query;
    if (error) throw new Error(`Failed to upsert ${table}: ${error.message}`);
    total += chunk.length;
  }
  return { rows: total };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!options.dryRun && (!supabaseUrl || !serviceKey)) {
    throw new Error(
      "Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY. Use --dry-run to generate a local summary without writing."
    );
  }

  const sourceRows = readJson(options.sourceFile, []);
  if (!Array.isArray(sourceRows)) throw new Error(`${options.sourceFile} must be a JSON array`);

  const clubsByKey = groupClubRows(sourceRows);
  const bookingUrls = loadBookingUrls();
  const playability = loadPlayability();
  const conditions = loadConditions();
  const countyPriceStats = buildCountyPriceStats(clubsByKey);

  const supabase = options.dryRun
    ? null
    : createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
        realtime: { transport: WebSocket },
      });

  const supabaseClubs = supabase ? await fetchSupabaseClubs(supabase) : [];
  const teeTimeResult = supabase
    ? await fetchTeeTimeMetricsByClub(supabase, supabaseClubs)
    : {
        metricsByClub: new Map(),
        diagnostics: {
          source: "not_loaded_dry_run",
          resolved_rows: 0,
          raw_rows: 0,
          matched_raw_rows: 0,
          clubs_with_metrics: 0,
          fallback_used: false,
        },
      };
  const teeTimeMetricsByClubId = teeTimeResult.metricsByClub;
  const clubIdsByKey = new Map(
    supabaseClubs.map((club) => [normalizeClubKey(club.club_name), String(club.id)])
  );

  const allSignals = [];
  const enrichments = [];
  const qualityRows = [];
  const unmatched = [];
  const processed = [];
  let processedClubsWithTeeTimeMetrics = 0;

  for (const [key, club] of clubsByKey.entries()) {
    if (options.clubName && normalizeClubKey(options.clubName) !== key) continue;

    const clubId = clubIdsByKey.get(key) || (options.dryRun ? "00000000-0000-0000-0000-000000000000" : null);
    if (!clubId) {
      unmatched.push({ club_name: club.clubName, key });
      continue;
    }

    const bookingUrl = bookingUrls.get(key) || null;
    const play = playability.get(key) || null;
    const condition = conditions.get(key) || null;
    const price = derivePrice(club);
    const county = String(club.county || "").toLowerCase().trim();
    const countyStats = countyPriceStats.get(county) || null;
    const teeTimeMetrics = teeTimeMetricsByClubId.get(clubId) || null;
    if (teeTimeMetrics) processedClubsWithTeeTimeMetrics += 1;
    const signals = deriveClubSignals({
      clubId,
      club,
      bookingUrl,
      play,
      condition,
      price,
      countyStats,
      teeTimeMetrics,
    });

    allSignals.push(...signals);
    enrichments.push(deriveEnrichment(clubId, club, signals));
    qualityRows.push(deriveDataQuality(clubId, { club, bookingUrl, play, condition, price, signals, teeTimeMetrics }));
    processed.push(club.clubName);
  }

  if (!options.dryRun && supabase) {
    await upsertInChunks(supabase, "club_decision_signals", allSignals, {
      chunkSize: options.chunkSize,
      upsertOptions: { onConflict: "club_id,signal_key,signal_context" },
    });
    await upsertInChunks(supabase, "club_agent_enrichment", enrichments, {
      chunkSize: options.chunkSize,
      upsertOptions: { onConflict: "club_id" },
    });
    await upsertInChunks(supabase, "round_agent_data_quality", qualityRows, {
      chunkSize: options.chunkSize,
      upsertOptions: { onConflict: "club_id" },
    });
  }

  const summary = {
    dry_run: options.dryRun,
    source_version: SOURCE_VERSION,
    source_file: options.sourceFile,
    processed_clubs: processed.length,
    unmatched_clubs: unmatched.length,
    decision_signals: allSignals.length,
    enrichments: enrichments.length,
    data_quality_rows: qualityRows.length,
    signal_counts: countBy(allSignals, "signal_key"),
    confidence_counts: countBy(allSignals, "confidence"),
    tee_time_diagnostics: {
      ...teeTimeResult.diagnostics,
      processed_clubs_with_tee_time_metrics: processedClubsWithTeeTimeMetrics,
    },
    unmatched: unmatched.slice(0, 50),
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(path.resolve(options.summaryFile), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = String(row?.[field] ?? "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
