import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const livePath = path.join(projectRoot, "src/data/course-conditions-live.json");
const staticPath = path.join(projectRoot, "src/data/course-conditions-static.json");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXAMPLE_KEYS = ["banstead downs", "coombe wood", "epsom", "kingswood"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function scaledContribution(value, inMin, inMax, outMin, outMax) {
  const v = Number(value);
  if (!Number.isFinite(v) || inMin === inMax) return outMin;
  const t = clamp((v - inMin) / (inMax - inMin), 0, 1);
  return outMin + t * (outMax - outMin);
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

function computeDrynessStress(row) {
  const metrics = row.metrics || {};
  const balance = Number(metrics.soilMoistureBalance ?? 0);
  const et0Total = Number(metrics.et0Total14d ?? 0);
  const daysSinceRain5 = Number(metrics.daysSinceRain5 ?? 0);
  const rain72hMm = Number(metrics.rain72hMm ?? 0);
  const rain7dMm = Number(metrics.rain7dMm ?? 0);
  const forecast48hMm = Number(metrics.forecast48hMm ?? 0);
  const rawMaxTemp7dC = metrics.maxTemp7dC;
  const hasMaxTemp7dC = rawMaxTemp7dC !== null && rawMaxTemp7dC !== undefined;
  const maxTemp7dC = Number(rawMaxTemp7dC);
  const season = Number(row.season_index ?? 0);
  const drainage = String(row.drainage_bucket || "").toUpperCase();
  const soil = String(row.soil_type || "").toLowerCase();

  let score = 0;
  const reasons = [];
  const missingInputs = [];

  const soilDryness = scaledContribution(balance, -40, -180, 0, 1.6);
  score += soilDryness;
  if (soilDryness >= 1.2) reasons.push("Soil moisture balance is extremely dry");
  else if (soilDryness >= 0.8) reasons.push("Soil moisture balance is very dry");
  else if (soilDryness > 0) reasons.push("Soil moisture balance is drying out");

  const dryingDemand = scaledContribution(et0Total, 60, 180, 0, 1.1);
  score += dryingDemand;
  if (dryingDemand >= 0.8) {
    reasons.push("High evapotranspiration has been drying the course quickly");
  } else if (dryingDemand > 0) {
    reasons.push("Recent drying demand is elevated");
  }

  if (daysSinceRain5 >= 7) {
    score += 0.3 + scaledContribution(daysSinceRain5, 7, 21, 0, 0.6);
    if (daysSinceRain5 >= 10) reasons.push("No meaningful rain for over a week");
    else reasons.push("Meaningful rain has been absent for several days");
  }

  score += scaledContribution(rain7dMm, 5, 0, 0, 0.4);
  score += scaledContribution(rain72hMm, 3, 0, 0, 0.2);
  score += scaledContribution(forecast48hMm, 2, 0, 0, 0.2);
  if (forecast48hMm >= 8) score -= scaledContribution(forecast48hMm, 8, 20, 0, 0.4);

  if (hasMaxTemp7dC && Number.isFinite(maxTemp7dC)) {
    const heatStress = scaledContribution(maxTemp7dC, 24, 32, 0, 0.5);
    score += heatStress;
    if (heatStress >= 0.25) reasons.push("Recent heat increases parched fairway risk");
    else if (heatStress > 0) reasons.push("Recent warm days increase firm-ground risk");
  } else {
    missingInputs.push("maxTemp7dC");
    reasons.push("Max temperature unavailable; heat contribution excluded");
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

  return { score, level, missingInputs, reasons: reasons.slice(0, 3) };
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

function moistureLabelFromScore(score) {
  if (score >= 8.2) return "Firm";
  if (score >= 6.8) return "Good";
  if (score >= 5.3) return "Soft";
  return "Wet";
}

function computeMoistureScore10(row) {
  const buckets = row.buckets || {};
  let score = 8.8;

  if (buckets.rain === "R1") score -= 0.8;
  if (buckets.rain === "R2") score -= 2.2;
  if (buckets.soil === "S1") score -= 0.8;
  if (buckets.soil === "S2") score -= 2.0;
  if (buckets.forecast === "FC1") score -= 0.4;
  if (buckets.forecast === "FC2") score -= 1.0;
  if (buckets.frost === "F1") score -= 0.8;
  if (buckets.frost === "F2") score -= 2.0;

  if (row.risk === "moderate") score = Math.min(score, 6.9);
  if (row.risk === "high") score = Math.min(score, 4.8);

  return Math.round(clamp(score, 0, 10) * 10) / 10;
}

function bandForScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return "hidden";
  if (score < 1) return "0";
  if (score <= 3) return "1-3";
  if (score <= 6) return "4-6";
  if (score < 10) return "7-9";
  return "10";
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function buildStaticLookup(staticRowsByKey) {
  const map = new Map();
  for (const row of Object.values(staticRowsByKey)) {
    if (!row?.club_name) continue;
    map.set(normalizeClubNameForLookup(row.club_name), row);
  }
  return map;
}

function auditRows(rows, staticByLookupKey, now) {
  const distribution = {
    total: 0,
    visible: 0,
    hidden: 0,
    bands: { hidden: 0, "0": 0, "1-3": 0, "4-6": 0, "7-9": 0, "10": 0 },
    labels: { Firm: 0, Good: 0, Soft: 0, Wet: 0 },
    confidence: { high: 0, medium: 0, low: 0, none: 0 },
    dryStressFlag: { none: 0, low: 0, moderate: 0, severe: 0 },
    hiddenReasons: {},
  };
  const examples = {};
  const wetLabelExamples = [];

  for (const row of rows) {
    distribution.total++;

    if (!hasRequiredLiveInputs(row)) {
      distribution.hidden++;
      increment(distribution.bands, "hidden");
      increment(distribution.confidence, "low");
      increment(distribution.hiddenReasons, "missing_live_model_inputs");
      continue;
    }

    const staticRow =
      staticByLookupKey.get(normalizeClubNameForLookup(row.club_name)) || null;
    const hasRealStaticDrainage = Boolean(staticRow?.drainage_bucket);
    const fresh = hasFreshLiveRow(row, now);
    const confidence = hasRealStaticDrainage && fresh ? "high" : fresh ? "medium" : "low";
    const drynessStress = row.drynessStress || computeDrynessStress(row);
    const dryStressFlag = row.dryStressFlag || drynessStress.level;
    const conditionScore =
      typeof row.condition_score_10 === "number"
        ? row.condition_score_10
        : computeConditionScore10(row, drynessStress);
    const moistureScore =
      typeof row.moisture_score_10 === "number"
        ? row.moisture_score_10
        : computeMoistureScore10(row);
    const moistureLabel = row.moisture_label || moistureLabelFromScore(moistureScore);

    distribution.visible++;
    increment(distribution.bands, bandForScore(moistureScore));
    increment(distribution.labels, moistureLabel);
    increment(distribution.confidence, confidence);
    increment(distribution.dryStressFlag, dryStressFlag);

    if (moistureLabel === "Wet" && wetLabelExamples.length < 3) {
      wetLabelExamples.push({
        club_name: row.club_name,
        moisture_score_10: moistureScore,
        moisture_label: moistureLabel,
        buckets: {
          rain: row.buckets?.rain ?? null,
          soil: row.buckets?.soil ?? null,
          forecast: row.buckets?.forecast ?? null,
        },
        dryStressFlag,
      });
    }

    if (EXAMPLE_KEYS.includes(row.club_key)) {
      examples[row.club_key] = {
        club_name: row.club_name,
        condition_score_10: conditionScore,
        moisture_score_10: moistureScore,
        moisture_label: moistureLabel,
        dryStressFlag,
        drynessStress,
        metrics: {
          daysSinceRain5: row.metrics?.daysSinceRain5 ?? null,
          rain72hMm: row.metrics?.rain72hMm ?? null,
          rain7dMm: row.metrics?.rain7dMm ?? null,
          soilMoistureBalance: row.metrics?.soilMoistureBalance ?? null,
          et0Total14d: row.metrics?.et0Total14d ?? null,
          forecast48hMm: row.metrics?.forecast48hMm ?? null,
          maxTemp7dC: row.metrics?.maxTemp7dC ?? null,
        },
        buckets: row.buckets,
      };
    }
  }

  return { distribution, examples, wetLabelExamples };
}

function main() {
  const liveRowsByKey = readJson(livePath);
  const staticRowsByKey = readJson(staticPath);
  const rows = Object.values(liveRowsByKey).filter((row) => row && !row.error);
  const staticByLookupKey = buildStaticLookup(staticRowsByKey);
  const now = new Date();
  const { distribution, examples, wetLabelExamples } = auditRows(
    rows,
    staticByLookupKey,
    now
  );

  console.log(
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        inputs: {
          livePath,
          staticPath,
          liveRows: rows.length,
          staticRows: Object.keys(staticRowsByKey).length,
        },
        proposedScorer: distribution,
        exampleClubs: examples,
        wetLabelExamples,
        drainageFallback: {
          assumedDefault: "D3",
          realStaticDrainageRows: rows.filter((row) =>
            Boolean(
              staticByLookupKey.get(normalizeClubNameForLookup(row.club_name))
                ?.drainage_bucket
            )
          ).length,
          liveD3FallbackRows: rows.filter((row) => {
            const staticRow = staticByLookupKey.get(
              normalizeClubNameForLookup(row.club_name)
            );
            return !staticRow?.drainage_bucket && row.drainage_bucket === "D3";
          }).length,
        },
        allowedMoistureLabels: ["Firm", "Good", "Soft", "Wet"],
      },
      null,
      2
    )
  );
}

main();
