import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const livePath = path.join(projectRoot, "src/data/course-conditions-live.json");
const staticPath = path.join(projectRoot, "src/data/course-conditions-static.json");

const BASE_SCORE = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeClubNameForLookup(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['’]/g, "")
    .replace(/\b(the)\b/g, "")
    .replace(
      /\b(golf club|golfcourse|golf course|country club|golf & country club|gc)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function toDrainageProxyBand(drainageBucket) {
  const bucket = String(drainageBucket || "").toUpperCase();
  if (bucket === "D0" || bucket === "D1") return "good";
  if (bucket === "D2") return "ok";
  if (bucket === "D3" || bucket === "D4") return "poor";
  return "unknown";
}

function parseRainBucket(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  if (
    /\b(heavy rain|very wet|waterlogged|saturated|persistent rain|boggy)\b/.test(
      normalized
    )
  ) {
    return "R2";
  }
  if (/\b(light rain|showers|rain)\b/.test(normalized)) return "R1";
  if (/\b(dry|firm|no rain)\b/.test(normalized)) return "R0";
  return null;
}

function parseFrostBucket(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  if (/\b(hard frost|frozen|snow|ice)\b/.test(normalized)) return "F2";
  if (/\b(frost|frosty|frost delay|frost delays)\b/.test(normalized)) return "F1";
  if (/\b(no frost)\b/.test(normalized)) return "F0";
  return null;
}

function inferWeatherBuckets({ conditionLabel, conditionBlurb }) {
  const joined = [conditionLabel, conditionBlurb].filter(Boolean).join(" ");
  return {
    rainBucket: parseRainBucket(joined),
    frostBucket: parseFrostBucket(joined),
  };
}

function computeCurrentPlayabilityScore({
  rainBucket,
  frostBucket,
  drainageProxyBand,
  now = new Date(),
}) {
  let score = BASE_SCORE;

  if (rainBucket === "R0") score += 0.4;
  if (rainBucket === "R2") score -= 1.4;
  if (frostBucket === "F1") score -= 0.8;
  if (frostBucket === "F2") score -= 2.0;
  if (drainageProxyBand === "good") score += 0.6;
  if (drainageProxyBand === "poor") score -= 0.8;

  const month = now.getMonth();
  if (month === 10 || month === 11 || month === 0 || month === 1) {
    score -= 0.4;
  }

  score = Math.round(clamp(score, 0, 10) * 10) / 10;

  let label = "Wet";
  if (score >= 8.2) label = "Firm";
  else if (score >= 6.8) label = "Good";
  else if (score >= 5.3) label = "Soft";

  const visible =
    (rainBucket !== null || frostBucket !== null) &&
    drainageProxyBand !== "unknown";

  return { score, label, visible };
}

function currentScorer(row, staticByLookupKey, now) {
  const staticRow =
    staticByLookupKey.get(normalizeClubNameForLookup(row.club_name)) || null;
  const conditionLabel = String(row.condition_label || "").trim() || null;
  const conditionBlurb = String(row.condition_blurb || "").trim() || null;

  if (!conditionLabel && !conditionBlurb) {
    return {
      visible: false,
      reason: "missing_live_text",
      score: null,
      label: null,
      confidence: "none",
    };
  }

  const weatherBuckets = inferWeatherBuckets({
    conditionLabel,
    conditionBlurb,
  });
  const drainageProxyBand = toDrainageProxyBand(staticRow?.drainage_bucket);
  const result = computeCurrentPlayabilityScore({
    rainBucket: weatherBuckets.rainBucket,
    frostBucket: weatherBuckets.frostBucket,
    drainageProxyBand,
    now,
  });

  if (!result.visible) {
    return {
      visible: false,
      reason:
        drainageProxyBand === "unknown"
          ? "missing_static_drainage"
          : "unparsed_weather_text",
      score: null,
      label: null,
      confidence: "none",
      rainBucket: weatherBuckets.rainBucket,
      frostBucket: weatherBuckets.frostBucket,
      drainageProxyBand,
    };
  }

  return {
    ...result,
    reason: "visible",
    confidence: "high",
    rainBucket: weatherBuckets.rainBucket,
    frostBucket: weatherBuckets.frostBucket,
    drainageProxyBand,
  };
}

function hasFreshLiveRow(row, now) {
  const updatedAt = Date.parse(row.updated_at || "");
  if (!Number.isFinite(updatedAt)) return false;
  return now.getTime() - updatedAt <= 5 * MS_PER_DAY;
}

function hasRequiredLiveInputs(row) {
  return (
    row &&
    row.risk &&
    typeof row.score === "number" &&
    row.buckets &&
    row.metrics &&
    row.drainage_bucket &&
    row.season_index !== undefined
  );
}

// ===========================================================================
// Mirrors the fixed logic in build-conditions-live.mjs. Kept in sync manually
// for now — flagged as a follow-up to extract into one shared module.
// ===========================================================================
function scaledContribution(value, from, to, maxValue) {
  if (from === to) return 0;
  const t = (value - from) / (to - from);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(clamped * maxValue * 100) / 100;
}

function computeDrynessStress(row) {
  const metrics = row.metrics || {};
  const balance = Number(metrics.soilMoistureBalance ?? 0);
  const et0Total = Number(metrics.et0Total14d ?? 0);
  const daysSinceRain5 = Number(metrics.daysSinceRain5 ?? 0);
  const rain72hMm = Number(metrics.rain72hMm ?? 0);
  const rain7dMm = Number(metrics.rain7dMm ?? 0);
  const forecast48hMm = Number(metrics.forecast48hMm ?? 0);
  const season = Number(row.season_index ?? 0);
  const drainage = String(row.drainage_bucket || "").toUpperCase();
  const soil = String(row.soil_type || "").toLowerCase();

  const maxTemp7dCRaw = metrics.maxTemp7dC;
  const maxTemp7dCPresent =
    maxTemp7dCRaw !== null && maxTemp7dCRaw !== undefined && Number.isFinite(Number(maxTemp7dCRaw));
  const maxTemp7dC = maxTemp7dCPresent ? Number(maxTemp7dCRaw) : null;

  const missingInputs = [];
  if (!maxTemp7dCPresent) missingInputs.push("maxTemp7dC");

  let score = 0;
  const reasons = [];

  const balanceContribution = scaledContribution(balance, -40, -180, 1.6);
  if (balanceContribution > 0) {
    score += balanceContribution;
    reasons.push(
      balance <= -80 ? "Soil moisture balance is very dry" : "Soil moisture balance is drying out"
    );
  }

  const et0Contribution = scaledContribution(et0Total, 60, 180, 1.1);
  if (et0Contribution > 0) {
    score += et0Contribution;
    reasons.push(
      et0Total >= 120
        ? "High evapotranspiration has been drying the course quickly"
        : "Recent drying demand is elevated"
    );
  }

  if (daysSinceRain5 >= 7) {
    const daysContribution = 0.3 + scaledContribution(daysSinceRain5, 7, 21, 0.6);
    score += daysContribution;
    reasons.push(
      daysSinceRain5 >= 14
        ? "No meaningful rain for an extended period"
        : "Meaningful rain has been absent for several days"
    );
  }

  score += scaledContribution(5 - rain7dMm, 0, 5, 0.4);
  score += scaledContribution(3 - rain72hMm, 0, 3, 0.2);
  score += scaledContribution(2 - forecast48hMm, 0, 2, 0.2);
  score -= scaledContribution(forecast48hMm, 8, 20, 0.4);

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

  score = Math.round(clamp(score, 0, 5) * 10) / 10;

  let level = "none";
  if (score >= 3.6) level = "severe";
  else if (score >= 2.2) level = "moderate";
  else if (score >= 0.7) level = "low";

  return { score, level, reasons: reasons.slice(0, 3), missingInputs };
}

function computeConditionScore10(row, drynessStress) {
  let score = 8.8 - Math.min(Math.max(Number(row.score) || 0, 0), 14) * 0.45;

  if (row.risk === "moderate") score = Math.min(score, 6.9);
  if (row.risk === "high") score = Math.min(score, 4.2);

  const drainageBucket = String(row.drainage_bucket || "").toUpperCase();
  if (drainageBucket === "D0" || drainageBucket === "D1") score += 0.3;
  if (drainageBucket === "D3") score -= 0.4;
  if (drainageBucket === "D4") score -= 0.8;

  const buckets = row.buckets || {};
  if (buckets.forecast === "FC2") score -= 0.5;
  if (buckets.soil === "S2") score -= 0.6;
  score -= Number(drynessStress?.score || 0);

  return Math.round(clamp(score, 0, 10) * 10) / 10;
}

function proposedScorer(row, staticByLookupKey, now) {
  if (!hasRequiredLiveInputs(row)) {
    return {
      visible: false,
      reason: "missing_live_model_inputs",
      score: null,
      label: null,
      confidence: "low",
    };
  }

  const staticRow =
    staticByLookupKey.get(normalizeClubNameForLookup(row.club_name)) || null;
  const hasRealStaticDrainage = Boolean(staticRow?.drainage_bucket);
  const fresh = hasFreshLiveRow(row, now);
  const confidence = hasRealStaticDrainage && fresh ? "high" : fresh ? "medium" : "low";

  // Always recompute from raw inputs rather than trusting row.drynessStress,
  // since stored rows may have been generated by an older version of the
  // scoring logic (this was the source of a prior stale-data bug).
  const drynessStress = computeDrynessStress(row);
  const score = computeConditionScore10(row, drynessStress);

  let label = "Wet";
  if (score >= 8.2) label = "Firm";
  else if (score >= 6.8) label = "Good";
  else if (score >= 5.3) label = "Soft";

  return {
    visible: true,
    reason: "visible",
    score,
    label,
    confidence,
    drynessStress,
    condition_score_10: score,
    hasRealStaticDrainage,
    usedD3Default:
      !hasRealStaticDrainage && String(row.drainage_bucket || "").toUpperCase() === "D3",
  };
}

function bandForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return "hidden";
  if (score < 1) return "0";
  if (score <= 3) return "1-3";
  if (score <= 6) return "4-6";
  if (score < 10) return "7-9";
  return "10";
}

function initDistribution() {
  return {
    total: 0,
    visible: 0,
    hidden: 0,
    bands: { hidden: 0, "0": 0, "1-3": 0, "4-6": 0, "7-9": 0, "10": 0 },
    labels: {},
    confidence: { high: 0, medium: 0, low: 0, none: 0 },
    hiddenReasons: {},
  };
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function summarizeScores(rows, scorer, staticByLookupKey, now) {
  const dist = initDistribution();
  const examples = {
    hidden: [],
    lowConfidence: [],
    mediumConfidence: [],
  };

  for (const row of rows) {
    const result = scorer(row, staticByLookupKey, now);
    dist.total++;

    if (result.visible) dist.visible++;
    else dist.hidden++;

    increment(dist.bands, bandForScore(result.score));
    increment(dist.confidence, result.confidence || "none");
    if (result.label) increment(dist.labels, result.label);
    if (!result.visible) {
      increment(dist.hiddenReasons, result.reason || "unknown");
      if (examples.hidden.length < 12) {
        examples.hidden.push({
          club_key: row.club_key,
          club_name: row.club_name,
          reason: result.reason,
        });
      }
    }

    if (result.confidence === "low" && examples.lowConfidence.length < 12) {
      examples.lowConfidence.push({
        club_key: row.club_key,
        club_name: row.club_name,
        score: result.score,
        reason: result.reason,
      });
    }

    if (result.confidence === "medium" && examples.mediumConfidence.length < 12) {
      examples.mediumConfidence.push({
        club_key: row.club_key,
        club_name: row.club_name,
        score: result.score,
        drainage_bucket: row.drainage_bucket,
      });
    }
  }

  return { distribution: dist, examples };
}

function compareRealDrainageToD3(liveRows, staticByLookupKey) {
  const rowsWithRealDrainage = liveRows
    .map((row) => {
      const staticRow =
        staticByLookupKey.get(normalizeClubNameForLookup(row.club_name)) || null;
      return { row, staticDrainage: staticRow?.drainage_bucket || null };
    })
    .filter(({ staticDrainage }) => Boolean(staticDrainage));

  const byBucket = {};
  const byProxy = {};
  const mismatches = [];

  for (const { row, staticDrainage } of rowsWithRealDrainage) {
    const realBucket = String(staticDrainage).toUpperCase();
    const realProxy = toDrainageProxyBand(realBucket);
    const d3Proxy = toDrainageProxyBand("D3");
    increment(byBucket, realBucket);
    increment(byProxy, realProxy);

    if (realBucket !== "D3") {
      mismatches.push({
        club_key: row.club_key,
        club_name: row.club_name,
        realDrainage: realBucket,
        realProxy,
        d3Default: "D3",
        d3Proxy,
      });
    }
  }

  const total = rowsWithRealDrainage.length;
  const exactD3Matches = total - mismatches.length;
  const exactErrorRate = total ? mismatches.length / total : 0;
  const proxyMismatches = mismatches.filter((row) => row.realProxy !== row.d3Proxy);
  const proxyErrorRate = total ? proxyMismatches.length / total : 0;

  return {
    totalRealStaticDrainage: total,
    assumedDefault: "D3",
    realDrainageByBucket: byBucket,
    realDrainageByProxy: byProxy,
    exactD3Matches,
    exactD3Mismatches: mismatches.length,
    exactErrorRate,
    proxyMismatches: proxyMismatches.length,
    proxyErrorRate,
    mismatchExamples: mismatches.slice(0, 20),
  };
}

function buildStaticLookup(staticRowsByKey) {
  const map = new Map();
  for (const row of Object.values(staticRowsByKey)) {
    if (!row?.club_name) continue;
    map.set(normalizeClubNameForLookup(row.club_name), row);
  }
  return map;
}

function main() {
  const liveRowsByKey = readJson(livePath);
  const staticRowsByKey = readJson(staticPath);
  const liveRows = Object.values(liveRowsByKey).filter((row) => row && !row.error);
  const staticByLookupKey = buildStaticLookup(staticRowsByKey);
  const now = new Date();

  const current = summarizeScores(liveRows, currentScorer, staticByLookupKey, now);
  const proposed = summarizeScores(liveRows, proposedScorer, staticByLookupKey, now);
  const drainageFallback = compareRealDrainageToD3(liveRows, staticByLookupKey);

  const report = {
    generatedAt: now.toISOString(),
    inputs: {
      livePath,
      staticPath,
      liveRows: liveRows.length,
      staticRows: Object.keys(staticRowsByKey).length,
    },
    currentScorer: current,
    proposedScorer: proposed,
    drainageFallback,
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
