// scripts/build-conditions-live.mjs
// Weather + ET₀ soil-moisture balance + 48h forecast + course-type modifier
// + soil-type-aware thresholds + elevation penalty + season-aware buckets
// Writes src/data/course-conditions-live.json + upserts to Supabase

import fs from "node:fs";
import path from "node:path";

const clubsPath = path.resolve("src/data/clubs-enriched.json");
const outPath = path.resolve("src/data/course-conditions-live.json");
const staticConditionsPath = path.resolve("src/data/course-conditions-static.json");

const clubs = JSON.parse(fs.readFileSync(clubsPath, "utf8"));
if (!Array.isArray(clubs)) throw new Error("clubs-enriched.json must be a top-level array");
const staticConditions = JSON.parse(fs.readFileSync(staticConditionsPath, "utf8")) || {};

// Supabase (optional)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REQUIRE_SUPABASE_UPSERT =
  String(process.env.REQUIRE_SUPABASE_UPSERT || "").toLowerCase() === "true";
const OPEN_METEO_TIMEOUT_MS = Number(process.env.OPEN_METEO_TIMEOUT_MS || 12000);
const SUPABASE_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS || 10000);

if (REQUIRE_SUPABASE_UPSERT && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error(
    "REQUIRE_SUPABASE_UPSERT=true but SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY is missing."
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function upsertSupabaseRow(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const url = `${SUPABASE_URL}/rest/v1/club_conditions_live?on_conflict=club_key`;
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: "resolution=merge-duplicates",
  };

  const post = async (payloadRow) =>
    fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify([payloadRow]),
    }, SUPABASE_TIMEOUT_MS);

  let payload = { ...row };
  const removedColumns = new Set();

  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await post(payload);
    if (res.ok) return;

    const txt = await res.text();
    const m = txt.match(/Could not find the '([^']+)' column/i);
    const unknownColumn = m?.[1] || null;
    if (
      unknownColumn &&
      Object.prototype.hasOwnProperty.call(payload, unknownColumn) &&
      !removedColumns.has(unknownColumn)
    ) {
      removedColumns.add(unknownColumn);
      delete payload[unknownColumn];
      continue;
    }
    throw new Error(`Supabase upsert failed ${res.status}: ${txt.slice(0, 220)}`);
  }
  throw new Error("Supabase upsert failed after schema fallback retries.");
}

function normClubName(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/golf club|golf & country club|country club|golf course|the /g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.7 + Math.random() * 0.6));

function parseGeo(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : undefined;
}

// ===========================================================================
// SEASON CONTEXT — 6 bands (replaces old 3-band month bucket for scoring)
//
//  0 = Peak summer       (Jun–Aug):  fast drying, high ET₀, firm ground
//  1 = Late spring       (May):      warming, decent ET₀
//  2 = Early autumn      (Sep–Oct):  cooling, reducing ET₀, soils wetter by Oct
//  3 = Late autumn       (Nov):      cool, low ET₀, soils often wet
//  4 = Winter            (Dec–Feb):  near-zero ET₀, frozen/saturated risk
//  5 = Early spring      (Mar–Apr):  still cold, soils wet from winter
// ===========================================================================
function seasonIndex(month) {
  if (month >= 6 && month <= 8) return 0;   // peak summer
  if (month === 5)              return 1;   // late spring
  if (month === 9 || month === 10) return 2; // early autumn
  if (month === 11)             return 3;   // late autumn
  if (month === 12 || month <= 2) return 4; // winter
  return 5;                                 // Mar–Apr early spring
}

// Legacy 3-band bucket kept for blurb logic
function monthBucket(month) {
  if (month >= 5 && month <= 9) return "M0";
  if (month === 3 || month === 4 || month === 10) return "M1";
  return "M2";
}

// ===========================================================================
// SOIL TYPE
// ===========================================================================
const SOIL_PROFILE = {
  sand:  { fieldCap: 20,  drainDays: 1.5, rainSens: 0.6 },
  chalk: { fieldCap: 30,  drainDays: 2.5, rainSens: 0.8 },
  loam:  { fieldCap: 35,  drainDays: 3.5, rainSens: 1.0 },
  clay:  { fieldCap: 50,  drainDays: 6.0, rainSens: 1.3 },
  peat:  { fieldCap: 60,  drainDays: 8.0, rainSens: 1.5 },
};

function soilProfile(soilType) {
  return SOIL_PROFILE[String(soilType || "loam").toLowerCase()] ?? SOIL_PROFILE.loam;
}

// ===========================================================================
// COURSE TYPE MODIFIER (score delta)
// ===========================================================================
const COURSE_TYPE_MODIFIER = {
  links:      -2,
  coastal:    -1,
  heathland:  -1,
  downland:    0,
  parkland:   +1,
  meadowland: +2,
  moorland:   +1,
  unknown:     0,
};

function courseTypeModifier(courseType) {
  return COURSE_TYPE_MODIFIER[String(courseType || "unknown").toLowerCase().trim()] ?? 0;
}

// ===========================================================================
// ELEVATION PENALTY
// ===========================================================================
function elevationPenalty(elevationM) {
  const e = Number(elevationM || 0);
  if (e >= 300) return 3;
  if (e >= 150) return 1;
  return 0;
}

function elevationTempLapse(elevationM) {
  return (Number(elevationM || 0) / 100) * 0.65;
}

// ===========================================================================
// DRAINAGE PENALTY
// ===========================================================================
function drainagePenalty(bucket) {
  const b = String(bucket || "").toUpperCase();
  if (b === "D4") return 2;
  if (b === "D3") return 1;
  return 0;
}

// ===========================================================================
// ET₀ (Hargreaves-Samani) — FAO-56 Ra
// ===========================================================================
function dayOfYear(date) {
  const utcYear = date.getUTCFullYear();
  const start = Date.UTC(utcYear, 0, 0);
  const current = Date.UTC(utcYear, date.getUTCMonth(), date.getUTCDate());
  return Math.floor((current - start) / 86400000);
}

function extraterrestrialRadiation(latDeg, doy) {
  const phi   = (latDeg * Math.PI) / 180;
  const dr    = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws    = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
  const Gsc   = 0.0820;
  const Ra =
    ((24 * 60) / Math.PI) *
    Gsc *
    dr *
    (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
  return Math.max(Ra, 0);
}

function hargreavesET0(tminArr, tmaxArr, latDeg, referenceDate) {
  return tminArr.map((tmin, i) => {
    const tmax  = tmaxArr[i];
    const tmean = (tmin + tmax) / 2;
    const tRange = Math.max(tmax - tmin, 0);
    const doy   = dayOfYear(
      new Date(referenceDate.getTime() - (tminArr.length - 1 - i) * 86400000)
    );
    const Ra = extraterrestrialRadiation(latDeg, doy);
    return Math.max(0.0023 * (tmean + 17.8) * Math.sqrt(tRange) * Ra, 0);
  });
}

function computeSoilMoistureBalance(precipArr, tminArr, tmaxArr, latDeg, referenceDate) {
  const et0Arr = hargreavesET0(tminArr, tmaxArr, latDeg, referenceDate);
  let balance  = 0;
  for (let i = 0; i < precipArr.length; i++) {
    balance += (Number(precipArr[i]) || 0) - et0Arr[i];
  }
  return { balance, et0Total: et0Arr.reduce((a, b) => a + b, 0) };
}

// ===========================================================================
// SEASON-AWARE BUCKET THRESHOLDS
// ===========================================================================
function rainBucket(effectiveRain72hMm, season) {
  const T = [
    [10, 25], [ 8, 20], [ 7, 18], [ 6, 15], [ 5, 12], [ 5, 12],
  ];
  const [r1, r2] = T[season];
  if (effectiveRain72hMm >= r2) return "R2";
  if (effectiveRain72hMm >= r1) return "R1";
  return "R0";
}

function sinceRainBucket(daysSinceRain5, season, drainDays) {
  const SEASON_MULT = [0.7, 0.85, 1.0, 1.3, 1.6, 1.4];
  const scaled = drainDays * SEASON_MULT[season];
  const t0 = Math.max(1, Math.round(scaled * 0.5));
  const t1 = Math.max(2, Math.round(scaled * 1.2));
  if (daysSinceRain5 <= t0) return "T0";
  if (daysSinceRain5 <= t1) return "T1";
  return "T2";
}

function frostBucket(tmin3, elevationM) {
  const lapse        = elevationTempLapse(elevationM);
  const effectiveTmin = tmin3 - lapse;
  if (effectiveTmin <= 0) return "F2";
  if (effectiveTmin <= 4) return "F1";
  return "F0";
}

function monthBucket6(season) {
  return `MB${season}`;
}

function soilBucket(balance, fieldCap) {
  const saturated = fieldCap * 0.7;
  const moist     = fieldCap * 0.35;
  if (balance >= saturated) return "S2";
  if (balance >= moist)     return "S1";
  if (balance >= -3)        return "S0";
  return "S_dry";
}

function effectiveRain(rain72hMm, rainSens) {
  return rain72hMm * rainSens;
}

function forecastBucket(forecast48hMm) {
  if (forecast48hMm >= 10) return "FC2";
  if (forecast48hMm >= 4)  return "FC1";
  return "FC0";
}

// ===========================================================================
// DRYNESS STRESS — continuous/scaled contributions (fixes threshold-cliff
// saturation where distinct clubs all clamped to the same value)
// ===========================================================================

/**
 * Linear interpolation between `from` and `to`, returning a contribution
 * scaled to `maxValue`, clamped to [0, maxValue]. Works whether `from` is
 * larger or smaller than `to` — direction is handled automatically.
 */
function scaledContribution(value, from, to, maxValue) {
  if (from === to) return 0;
  const t = (value - from) / (to - from);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(clamped * maxValue * 100) / 100;
}

function computeDrynessStress({ metrics, season, drainageBucket, soilType }) {
  const balance = Number(metrics?.soilMoistureBalance ?? 0);
  const et0Total = Number(metrics?.et0Total14d ?? 0);
  const daysSinceRain5 = Number(metrics?.daysSinceRain5 ?? 0);
  const rain72hMm = Number(metrics?.rain72hMm ?? 0);
  const rain7dMm = Number(metrics?.rain7dMm ?? 0);
  const forecast48hMm = Number(metrics?.forecast48hMm ?? 0);
  const drainage = String(drainageBucket || "").toUpperCase();
  const soil = String(soilType || "").toLowerCase();

  const maxTemp7dCRaw = metrics?.maxTemp7dC;
  const maxTemp7dCPresent =
    maxTemp7dCRaw !== null && maxTemp7dCRaw !== undefined && Number.isFinite(Number(maxTemp7dCRaw));
  const maxTemp7dC = maxTemp7dCPresent ? Number(maxTemp7dCRaw) : null;

  const missingInputs = [];
  if (!maxTemp7dCPresent) missingInputs.push("maxTemp7dC");

  let score = 0;
  const reasons = [];

  // Soil moisture balance: -40 (start) -> -180 (max dry), 0 -> 1.6
  const balanceContribution = scaledContribution(balance, -40, -180, 1.6);
  if (balanceContribution > 0) {
    score += balanceContribution;
    if (balance <= -80) reasons.push("Soil moisture balance is very dry");
    else reasons.push("Soil moisture balance is drying out");
  }

  // ET0: 60 -> 180, 0 -> 1.1
  const et0Contribution = scaledContribution(et0Total, 60, 180, 1.1);
  if (et0Contribution > 0) {
    score += et0Contribution;
    reasons.push(
      et0Total >= 120
        ? "High evapotranspiration has been drying the course quickly"
        : "Recent drying demand is elevated"
    );
  }

  // Days since meaningful rain: starts contributing at day 7 (+0.3),
  // scales up to +0.9 by day 21
  if (daysSinceRain5 >= 7) {
    const daysContribution = 0.3 + scaledContribution(daysSinceRain5, 7, 21, 0.6);
    score += daysContribution;
    reasons.push(
      daysSinceRain5 >= 14
        ? "No meaningful rain for an extended period"
        : "Meaningful rain has been absent for several days"
    );
  }

  // Rain in last 7 days: inverse, 5mm -> 0mm, 0 -> 0.4
  score += scaledContribution(5 - rain7dMm, 0, 5, 0.4);

  // Rain in last 72h: inverse, 3mm -> 0mm, 0 -> 0.2
  score += scaledContribution(3 - rain72hMm, 0, 3, 0.2);

  // Forecast: dry forecast adds up to +0.2 (2mm -> 0mm), wet forecast
  // subtracts continuously from 8mm -> 20mm, up to -0.4
  score += scaledContribution(2 - forecast48hMm, 0, 2, 0.2);
  score -= scaledContribution(forecast48hMm, 8, 20, 0.4);

  // Recent heat — only when maxTemp7dC is actually available.
  // Continuous from 20C (no contribution) to 32C (max contribution).
  if (maxTemp7dCPresent) {
    const heatContribution = scaledContribution(maxTemp7dC, 20, 32, 0.6);
    if (heatContribution > 0) {
      score += heatContribution;
      reasons.push(
        maxTemp7dC >= 26
          ? "Recent heat increases parched fairway risk"
          : "Recent warm days increase firm-ground risk"
      );
    }
  }

  if (season === 0) score += 0.4;
  else if (season === 1 || season === 2) score += 0.2;

  if (drainage === "D0" || drainage === "D1") score += 0.2;
  if (soil === "sand" || soil === "chalk") score += 0.2;
  if (soil === "clay" || soil === "peat") score -= 0.2;

  // Widened clamp: 0-5 instead of 0-3, so subtotals like 3.7 and 4.4 don't
  // collapse to the same ceiling.
  score = Math.round(Math.max(0, Math.min(score, 5)) * 10) / 10;

  let level = "none";
  if (score >= 3.6) level = "severe";
  else if (score >= 2.2) level = "moderate";
  else if (score >= 0.7) level = "low";

  return {
    score,
    level,
    reasons: reasons.slice(0, 3),
    missingInputs,
  };
}

function computeConditionScore10({ risk, riskScore, buckets, drainageBucket, drynessStress }) {
  // Golfer-facing course-condition score. Do not feed this into quality scoring
  // or AI ranking; that caused conditions to be double-counted previously.
  let score = 8.8 - Math.min(Math.max(Number(riskScore) || 0, 0), 14) * 0.45;

  if (risk === "moderate") score = Math.min(score, 6.9);
  if (risk === "high") score = Math.min(score, 4.2);

  const drainage = String(drainageBucket || "").toUpperCase();
  if (drainage === "D0" || drainage === "D1") score += 0.3;
  if (drainage === "D3") score -= 0.4;
  if (drainage === "D4") score -= 0.8;

  if (buckets?.forecast === "FC2") score -= 0.5;
  if (buckets?.soil === "S2") score -= 0.6;
  score -= Number(drynessStress?.score || 0);

  return Math.round(Math.max(0, Math.min(score, 10)) * 10) / 10;
}

// ===========================================================================
// RISK MODEL
// ===========================================================================
function computeRisk({
  rain, sinceRain, frost, month6,
  drainagePenalty = 0, courseTypeMod = 0, elevPenalty = 0,
  rain7dMm = 0, wetDays7 = 0, soil, forecast,
}) {
  const monthScores = { MB0: 0, MB1: 1, MB2: 2, MB3: 3, MB4: 4, MB5: 3 };

  const p = {
    R0: 0,   R1: 3,  R2: 6,
    T2: 0,   T1: 1,  T0: 3,
    F0: 0,   F1: 2,  F2: 5,
    S_dry: -3, S0: 0, S1: 3, S2: 6,
    FC0: 0, FC1: 1, FC2: 3,
  };

  let score =
    p[rain] +
    p[sinceRain] +
    p[frost] +
    (monthScores[month6] ?? 0) +
    (p[soil] ?? 0) +
    p[forecast] +
    drainagePenalty +
    courseTypeMod +
    elevPenalty;

  if (rain7dMm >= 20) score += 2;
  if (rain7dMm >= 35) score += 2;
  if (wetDays7 >= 4)  score += 1;
  if (wetDays7 >= 6)  score += 2;

  score = Math.max(score, 0);

  let risk = score <= 4 ? "low" : score <= 10 ? "moderate" : "high";

  if (soil === "S2" && rain !== "R0") risk = "high";

  if (frost === "F2") {
    risk = (month6 === "MB4" || month6 === "MB5") ? "high" : "moderate";
  }

  if (rain === "R2" && sinceRain === "T0") risk = "high";

  if (soil === "S_dry" && rain === "R0" && drainagePenalty === 0 && courseTypeMod <= 0) {
    if (risk === "high") risk = "moderate";
  }

  if (soil === "S_dry" && rain === "R0" && sinceRain === "T2" && frost === "F0") {
    risk = "low";
  }

  if (forecast === "FC2" && (soil === "S1" || soil === "S2")) {
    if (risk === "low") risk = "moderate";
  }

  const reasons = [];
  if (rain === "R2") reasons.push([5, "Heavy rain in the last 72 hours"]);
  if (rain === "R1") reasons.push([3, "Recent rainfall"]);
  if (sinceRain === "T0") reasons.push([3, "Rain was very recent"]);
  if (soil === "S2") reasons.push([5, "Ground has accumulated significant moisture recently"]);
  if (soil === "S1") reasons.push([3, "Soil moisture balance is elevated"]);
  if (soil === "S_dry") reasons.push([2, "Dry spell has been drying the ground out"]);
  if (frost === "F2") reasons.push([5, "Hard frost risk — ground may be frozen"]);
  if (frost === "F1") reasons.push([2, "Ground frost possible given recent temperatures"]);
  if (month6 === "MB4") reasons.push([3, "Winter — ground unlikely to dry quickly"]);
  if (month6 === "MB5") reasons.push([2, "Early spring — soils still wet from winter"]);
  if (month6 === "MB3") reasons.push([2, "Late autumn — soils accumulating moisture"]);
  if (rain7dMm >= 20) reasons.push([2, "Sustained rainfall through the week"]);
  if (wetDays7 >= 4)  reasons.push([2, "Frequent recent rain days"]);
  if (forecast === "FC2") reasons.push([3, "Heavy rain forecast in the next 48 hours"]);
  if (forecast === "FC1") reasons.push([1, "Some rain expected in the next 48 hours"]);
  if (drainagePenalty >= 2) reasons.push([2, "Very poor drainage profile"]);
  else if (drainagePenalty === 1) reasons.push([1, "Poor drainage profile"]);
  if (elevPenalty >= 2) reasons.push([2, "Upland location — slower drying and higher frost risk"]);
  else if (elevPenalty === 1) reasons.push([1, "Elevated location adds moisture retention"]);
  if (courseTypeMod <= -1) reasons.push([1, "Fast-draining course type aids recovery"]);
  if (courseTypeMod >= 1)  reasons.push([1, "Soil type holds water longer than average"]);

  reasons.sort((a, b) => b[0] - a[0]);
  return { risk, score, reasons: reasons.slice(0, 3).map((r) => r[1]) };
}

// ===========================================================================
// LABEL DERIVATION
// ===========================================================================
function isWetDriven(buckets, metrics) {
  if (buckets?.rain === "R2") return true;
  if (buckets?.rain === "R1" && buckets?.sinceRain === "T0") return true;
  if ((metrics?.rain72hMm ?? 0) >= 20) return true;
  return false;
}

function deriveLabel(risk, buckets, metrics, drainageBucket, courseTypeMod, profile, season) {
  const dPenalty  = drainagePenalty(drainageBucket);
  const rain72hMm = Number(metrics?.rain72hMm || 0);
  const rain7dMm  = Number(metrics?.rain7dMm || 0);
  const wetDays7  = Number(metrics?.wetDays7 || 0);
  const balance   = Number(metrics?.soilMoistureBalance ?? 0);
  const et0Total  = Number(metrics?.et0Total14d ?? 0);
  const fc48h     = Number(metrics?.forecast48hMm || 0);

  const isWarmSeason   = season <= 2;
  const soilDry        = balance < (profile.fieldCap * 0.2);
  const et0Sufficient  = et0Total > (season === 0 ? 12 : 18);
  const noRecentRain   = rain72hMm < 3 && rain7dMm < 8 && wetDays7 <= 2;
  const goodForecast   = fc48h < 3;
  const noFrost        = buckets?.frost === "F0";
  const goodDrainage   = dPenalty === 0 || courseTypeMod <= -1;

  const goodConditionGate =
    risk === "low" &&
    isWarmSeason &&
    soilDry &&
    et0Sufficient &&
    noRecentRain &&
    goodForecast &&
    noFrost &&
    goodDrainage;

  if (goodConditionGate) return "Good Condition";

  if (buckets?.soil === "S2" && risk !== "low") return "Wet";

  if (risk === "moderate" && dPenalty >= 1 && (buckets?.rain === "R1" || buckets?.sinceRain === "T0")) {
    return "Soft";
  }

  if (fc48h >= 10 && risk === "moderate") return "Soft";
  if (fc48h >= 10 && risk === "low")      return "Playable";

  if (risk === "low")      return "Playable";
  if (risk === "moderate") return "Playable";

  return isWetDriven(buckets, metrics) || dPenalty >= 2 || buckets?.soil === "S2"
    ? "Wet"
    : "Soft";
}

// ===========================================================================
// BLURB
// ===========================================================================
function deriveBlurb(label, buckets, drainageBucket, courseType, metrics, season, elevationM) {
  const frostish  = buckets?.frost === "F2" || buckets?.frost === "F1";
  const poorDrain = drainagePenalty(drainageBucket) >= 1;
  const isLinks   = ["links", "heathland", "coastal"].includes(String(courseType || "").toLowerCase());
  const fc48h     = Number(metrics?.forecast48hMm || 0);
  const balance   = Number(metrics?.soilMoistureBalance ?? 0);
  const isUpland  = Number(elevationM || 0) >= 150;
  const isWinter  = season >= 3;

  if (label === "Wet") {
    if (isUpland && isWinter)  return "Conditions: Upland winter course — expect wet and heavy going across most areas.";
    if (poorDrain && !isLinks) return "Conditions: Recent rain plus weaker drainage suggest very wet ground underfoot.";
    if (balance >= 30)         return "Conditions: Sustained rainfall has saturated the ground — expect very wet conditions.";
    return "Conditions: High volumes of rain recently, so the course is likely wet underfoot.";
  }

  if (label === "Soft") {
    if (isLinks)    return "Conditions: Even with the natural drainage here, recent weather has left things softer than usual.";
    if (poorDrain)  return "Conditions: Likely playable, but softer underfoot due to recent rain and the drainage profile here.";
    if (frostish)   return "Conditions: Cold nights recently — expect soft or frozen patches, especially in shaded areas.";
    if (fc48h >= 4) return "Conditions: Course is soft and more rain is on the way — conditions may deteriorate through the day.";
    if (isWinter)   return "Conditions: Winter conditions mean the ground is soft and unlikely to firm up much.";
    return "Conditions: Recent weather suggests softer conditions around the course.";
  }

  if (label === "Playable") {
    if (isLinks)      return "Conditions: Likely playing fine — links drainage helps keep things firm even after recent weather.";
    if (frostish)     return "Conditions: Likely playable, though cold nights can leave softer or frozen patches in shaded areas.";
    if (fc48h >= 10)  return "Conditions: Playable today, but heavy rain is forecast — worth checking for closures before you go.";
    if (balance < -5) return "Conditions: Dry recent spell means the ground is firming up — likely playing well.";
    if (isUpland)     return "Conditions: Likely playable, though upland conditions can leave wetter patches in low-lying areas.";
    return "Conditions: Likely playable right now, with some softer areas possible.";
  }

  if (isLinks)       return "Conditions: Dry spell and fast-draining ground — this course is likely in great shape right now.";
  if (balance < -10) return "Conditions: Extended dry period has firmed the ground up well — should be playing nicely.";
  return "Conditions: Likely playing well right now, with fewer signs of weather impact recently.";
}

// ===========================================================================
// OPEN-METEO FETCH — 14 past days + 3 forecast days
// ===========================================================================
async function fetchOpenMeteoDaily(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,temperature_2m_min,temperature_2m_max` +
    `&past_days=14&forecast_days=3` +
    `&timezone=Europe%2FLondon`;

  const r = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "User-Agent": "ClublystConditionsBot/1.0" },
  }, OPEN_METEO_TIMEOUT_MS);

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Open-Meteo ${r.status}: ${txt.slice(0, 160)}`);
  }
  return r.json();
}

function metricsFromDaily(json, latDeg) {
  const precip = json?.daily?.precipitation_sum ?? [];
  const tmins  = json?.daily?.temperature_2m_min ?? [];
  const tmaxs  = json?.daily?.temperature_2m_max ?? [];

  const past          = precip.slice(0, 14);
  const forecastSlice = precip.slice(14, 17);
  const past7         = past.slice(-7);
  const past72h       = past.slice(-3);
  const forecastNext2 = forecastSlice.slice(0, 2);

  const rain72hMm     = past72h.reduce((a, b) => a + (Number(b) || 0), 0);
  const rain7dMm      = past7.reduce((a, b) => a + (Number(b) || 0), 0);
  const wetDays7      = past7.filter((v) => Number(v) >= 1).length;
  const forecast48hMm = forecastNext2.reduce((a, b) => a + (Number(b) || 0), 0);
  const past7Tmaxs    = tmaxs.slice(7, 14).map(Number).filter(Number.isFinite);
  const past14Tmaxs   = tmaxs.slice(0, 14).map(Number).filter(Number.isFinite);
  const maxTemp7dC    = past7Tmaxs.length ? Math.max(...past7Tmaxs) : null;
  const maxTemp14dC   = past14Tmaxs.length ? Math.max(...past14Tmaxs) : null;

  let daysSinceRain5 = 10;
  for (let i = past.length - 1, d = 0; i >= 0; i--, d++) {
    if (past[i] >= 5) { daysSinceRain5 = d; break; }
  }

  const last3Tmin = tmins.slice(11, 14);
  const tmin3     = last3Tmin.length ? Math.min(...last3Tmin) : 99;

  const pastTmins = tmins.slice(0, 14);
  const pastTmaxs = tmaxs.slice(0, 14);
  const { balance: soilMoistureBalance, et0Total: et0Total14d } = computeSoilMoistureBalance(
    past, pastTmins, pastTmaxs, latDeg, new Date()
  );

  return {
    rain72hMm,
    rain7dMm,
    wetDays7,
    daysSinceRain5,
    tmin3,
    forecast48hMm,
    maxTemp7dC:
      typeof maxTemp7dC === "number" ? Math.round(maxTemp7dC * 10) / 10 : null,
    maxTemp14dC:
      typeof maxTemp14dC === "number" ? Math.round(maxTemp14dC * 10) / 10 : null,
    soilMoistureBalance: Math.round(soilMoistureBalance * 10) / 10,
    et0Total14d: Math.round(et0Total14d * 10) / 10,
  };
}

// ===========================================================================
// DEDUPE
// ===========================================================================
function uniqueClubs(rows) {
  const map = new Map();
  for (const c of rows) {
    const name = String(c["Club Name"] || "").trim();
    if (!name) continue;
    const lat = parseGeo(c.latitude);
    const lon = parseGeo(c.longitude);
    if (lat === undefined || lon === undefined) continue;
    const key = normClubName(name);
    if (!map.has(key))
      map.set(key, { key, club_name: name, latitude: lat, longitude: lon });
  }
  return Array.from(map.values());
}

function londonMonthNow() {
  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "numeric",
  }).format(new Date());
  const n = Number(month);
  if (!Number.isFinite(n) || n < 1 || n > 12) return new Date().getUTCMonth() + 1;
  return n;
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("Starting live conditions build (season-aware + soil type + elevation + ET₀ + forecast)...");
  console.log("Rows in clubs-enriched.json:", clubs.length);
  console.log("Supabase upserts:", SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? "ENABLED" : "DISABLED");

  const u      = uniqueClubs(clubs);
  const month  = londonMonthNow();
  const season = seasonIndex(month);
  const mBucket = monthBucket(month);

  console.log(`Unique clubs with geo: ${u.length} | Season index: ${season} (${
    ["peak summer","late spring","early autumn","late autumn","winter","early spring"][season]
  })`);

  const output = {};
  const DELAY_MS = 250;
  const RETRIES  = 3;
  let processed = 0, errors = 0, supabaseUpserts = 0, supabaseErrors = 0;

  for (let i = 0; i < u.length; i++) {
    const club = u[i];

    try {
      let weather = null;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          weather = await fetchOpenMeteoDaily(club.latitude, club.longitude);
          break;
        } catch (e) {
          if (attempt === RETRIES - 1) throw e;
          await sleep(jitter(800 * Math.pow(2, attempt)));
        }
      }

      const met = metricsFromDaily(weather, club.latitude);

      const staticRow      = staticConditions?.[club.key] || null;
      const drainageBucket = staticRow?.drainage_bucket || "D3";
      const courseType     = staticRow?.course_type   || "unknown";
      const soilType       = staticRow?.soil_type     || "loam";
      const elevationM     = staticRow?.elevation_m   || 0;

      const profile  = soilProfile(soilType);
      const dPenalty = drainagePenalty(drainageBucket);
      const ctMod    = courseTypeModifier(courseType);
      const elevP    = elevationPenalty(elevationM);

      const effRain72h = effectiveRain(met.rain72hMm, profile.rainSens);

      const buckets = {
        rain:      rainBucket(effRain72h, season),
        sinceRain: sinceRainBucket(met.daysSinceRain5, season, profile.drainDays),
        frost:     frostBucket(met.tmin3, elevationM),
        month:     mBucket,
        month6:    monthBucket6(season),
        soil:      soilBucket(met.soilMoistureBalance, profile.fieldCap),
        forecast:  forecastBucket(met.forecast48hMm),
      };

      const out = computeRisk({
        rain:           buckets.rain,
        sinceRain:      buckets.sinceRain,
        frost:          buckets.frost,
        month6:         buckets.month6,
        drainagePenalty: dPenalty,
        courseTypeMod:  ctMod,
        elevPenalty:    elevP,
        rain7dMm:       met.rain7dMm,
        wetDays7:       met.wetDays7,
        soil:           buckets.soil,
        forecast:       buckets.forecast,
      });
      const drynessStress = computeDrynessStress({
        metrics: met,
        season,
        drainageBucket,
        soilType,
      });
      const condition_score_10 = computeConditionScore10({
        risk: out.risk,
        riskScore: out.score,
        buckets,
        drainageBucket,
        drynessStress,
      });

      const condition_label = deriveLabel(
        out.risk, buckets, met, drainageBucket, ctMod, profile, season
      );
      const condition_blurb = deriveBlurb(
        condition_label, buckets, drainageBucket, courseType, met, season, elevationM
      );

      const row = {
        club_key:   club.key,
        club_name:  club.club_name,
        latitude:   club.latitude,
        longitude:  club.longitude,
        risk:       out.risk,
        score:      out.score,
        condition_score_10,
        reasons:    out.reasons,
        condition_label,
        condition_blurb,
        drainage_bucket: drainageBucket,
        course_type:     courseType,
        soil_type:       soilType,
        elevation_m:     elevationM,
        drynessStress,
        buckets,
        metrics: met,
        season_index: season,
        updated_at: new Date().toISOString(),
        source: "open-meteo",
      };

      output[club.key] = row;

      const supabaseRow = {
        club_key: row.club_key,        club_name: row.club_name,
        latitude: row.latitude,        longitude: row.longitude,
        risk: row.risk,                score: row.score,
        condition_score_10: row.condition_score_10,
        reasons: row.reasons,          condition_label: row.condition_label,
        condition_blurb: row.condition_blurb,
        drainage_bucket: row.drainage_bucket,
        course_type: row.course_type,  soil_type: row.soil_type,
        elevation_m: row.elevation_m,  drynessStress: row.drynessStress,
        buckets: row.buckets,
        metrics: row.metrics,          season_index: row.season_index,
        updated_at: row.updated_at,    source: row.source,
      };

      try {
        await upsertSupabaseRow(supabaseRow);
        if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) supabaseUpserts++;
      } catch (e) {
        supabaseErrors++;
        console.log(`Supabase upsert error for ${club.key}: ${String(e?.message || e).slice(0, 180)}`);
      }

      processed++;
      if (processed % 50 === 0) console.log(`Processed: ${processed}/${u.length}`);
      await sleep(DELAY_MS);
    } catch (e) {
      errors++;
      output[club.key] = {
        club_key: club.key, club_name: club.club_name,
        latitude: club.latitude, longitude: club.longitude,
        error: String(e?.message || e),
        updated_at: new Date().toISOString(), source: "open-meteo",
      };
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("DONE");
  console.log(`Processed: ${processed} | Errors: ${errors}`);
  console.log(`Supabase upserts: ${supabaseUpserts} | Supabase errors: ${supabaseErrors}`);
  console.log(`Wrote ${Object.keys(output).length} clubs to ${outPath}`);

  if (REQUIRE_SUPABASE_UPSERT && supabaseUpserts === 0) {
    throw new Error("Supabase upserts were required but zero rows were upserted.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
