import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const DEFAULT_OUTPUT = "round-agent-ranking-harness-report.json";
const DEFAULT_LIMIT = 8;

const LONDON_ORIGIN_CONTEXTS = new Set([
  "south_west_london",
  "west_london",
  "south_london",
  "north_london",
  "east_london",
  "central_london",
]);

const CANONICAL_CASES = [
  {
    id: "south_west_london_fourball_longer_weekend_pace",
    prompt:
      "I am looking for a longer course near london for a group of 4, ideally its not a busy course on weekends and the rounds dont take forever",
    context: {
      source_surface: "browse",
      origin_context: "south_west_london",
      origin_label: "South West London",
    },
    expectations: [
      "Prefer south-west-accessible corridors over North London",
      "Prioritise longer/full 18 courses",
      "Treat four-ball/weekend/pace as proxy signals, not firm claims",
    ],
  },
  {
    id: "wet_weather_value_near_me",
    prompt: "Somewhere near me under £50 that will still be decent if it rains",
    context: {
      source_surface: "browse",
      origin_context: "south_west_london",
      origin_label: "South West London",
    },
    expectations: [
      "Prioritise wet-weather fit, value and south-west access",
      "Respect budget as a strong preference",
    ],
  },
  {
    id: "beginner_friendly_not_too_expensive",
    prompt: "I want an easy course for a newer golfer, ideally not too expensive",
    context: {
      source_surface: "browse",
      origin_context: "south_west_london",
      origin_label: "South West London",
    },
    expectations: [
      "Prioritise beginner-friendly and forgiving courses",
      "Avoid over-weighting long/challenging courses",
    ],
  },
];

function parseArgs(argv) {
  const options = {
    prompt: null,
    originContext: "south_west_london",
    output: DEFAULT_OUTPUT,
    limit: DEFAULT_LIMIT,
    canonical: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--canonical") {
      options.canonical = true;
      continue;
    }
    if (arg === "--prompt") {
      options.prompt = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (arg === "--origin-context") {
      options.originContext = normalizeToken(argv[index + 1]) || options.originContext;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = String(argv[index + 1] || "").trim() || DEFAULT_OUTPUT;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const limit = Number(argv[index + 1]);
      if (Number.isInteger(limit) && limit > 0) options.limit = limit;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.canonical && !options.prompt) {
    options.canonical = true;
  }

  return options;
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function confidenceScore(confidence) {
  if (confidence === "high") return 100;
  if (confidence === "medium") return 70;
  if (confidence === "low") return 35;
  return 50;
}

function signalScore(signal, fallback = 50) {
  if (signal?.confidence === "low") return fallback;
  const score = Number(signal?.signal_score);
  if (Number.isFinite(score)) return clamp(score);
  const value = String(signal?.signal_value || "").toLowerCase();
  if (["strong", "positive", "high"].includes(value)) return 85;
  if (["medium", "moderate"].includes(value)) return 62;
  if (["weak", "negative", "low"].includes(value)) return 25;
  return fallback;
}

function intentFromPrompt(prompt, context = {}) {
  const text = normalizeText(prompt);
  const budgetMatch = text.match(/(?:under|below|max|maximum|less than)\s*£?\s*(\d{2,3})/i);
  const playersMatch = text.match(/\b(?:group of|for)\s*(\d)\b/i);
  const originContext = normalizeToken(context.origin_context) || null;

  return {
    raw_prompt: prompt,
    location_query: text.includes("london")
      ? "london"
      : text.includes("surrey")
        ? "surrey"
        : text.includes("berkshire")
          ? "berkshire"
          : null,
    origin_context: LONDON_ORIGIN_CONTEXTS.has(originContext) ? originContext : null,
    budget_max: budgetMatch ? Number(budgetMatch[1]) : null,
    budget_constraint_type: /\bmust\b|\bhas to\b|\bneed(?:s)? to\b/.test(text) ? "hard" : "preference",
    players: playersMatch ? Number(playersMatch[1]) : text.includes("four") ? 4 : null,
    wants_longer_course: /\blong(?:er)?\b|\bproper\s+18\b|\bfull\s+18\b/.test(text),
    wants_full_18: /\b18\b|\bfull\b|\blong(?:er)?\b/.test(text),
    wants_easy: /\beasy\b|\bnewer\b|\bbeginner\b|\bnot too hard\b|\bforgiving\b/.test(text),
    wants_wet_weather: hasAny(text, [
      /\brain(?:s|y|ing)?\b/,
      /\bwet\b/,
      /\bdrain(?:s|age|ing)?\b/,
      /\bwinter\b/,
    ]),
    wants_value: /\bvalue\b|\bcheap\b|\bnot too expensive\b|\bunder\b|\bbudget\b/.test(text),
    wants_weekend: /\bweekends?\b|\bsaturday\b|\bsunday\b/.test(text),
    wants_low_crowding: hasAny(text, [
      /\bnot\s+(?:a\s+)?busy\b/,
      /\bless busy\b/,
      /\bquiet\b/,
      /\bnot crowded\b/,
      /\bget on\b/,
      /\bimpossible to get on\b/,
    ]),
    wants_pace: hasAny(text, [
      /\b(?:don'?t|doesn'?t|do not|does not|not)\s+take\s+forever\b/,
      /\brounds?\s+(?:don'?t|do not)\s+take\s+forever\b/,
      /\bquick\b/,
      /\bpace\b/,
      /\bfast\b/,
      /\bnot slow\b/,
    ]),
  };
}

function buildWeights(intent) {
  const weights = {
    access: intent.location_query || intent.origin_context ? 0.22 : 0.08,
    length: intent.wants_longer_course ? 0.2 : 0.06,
    full18: intent.wants_full_18 ? 0.08 : 0.04,
    beginner: intent.wants_easy ? 0.16 : 0.04,
    wet: intent.wants_wet_weather ? 0.18 : 0.04,
    value: intent.wants_value || intent.budget_max ? 0.16 : 0.08,
    availability: intent.wants_weekend || intent.wants_low_crowding || intent.wants_pace ? 0.16 : 0.05,
    weekend: intent.wants_weekend || intent.wants_low_crowding ? 0.14 : 0.03,
    fourball: intent.players && intent.players >= 4 ? 0.12 : 0.03,
    pace: intent.wants_pace || intent.wants_low_crowding ? 0.1 : 0.03,
    booking: 0.04,
    confidence: 0.08,
  };

  if (intent.players && intent.players >= 4) {
    weights.full18 += 0.03;
    weights.booking += 0.02;
  }

  if (intent.wants_weekend || intent.wants_low_crowding || intent.wants_pace) {
    weights.confidence += 0.04;
  }

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total]));
}

function keyForSignal(signal) {
  return `${signal.signal_key}:${signal.signal_context || "global"}`;
}

function groupSignals(rows) {
  const byClub = new Map();
  for (const row of rows || []) {
    const clubId = String(row.club_id || "");
    if (!clubId) continue;
    if (!byClub.has(clubId)) byClub.set(clubId, new Map());
    byClub.get(clubId).set(keyForSignal(row), row);
  }
  return byClub;
}

function getSignal(signalMap, key, context = "global") {
  return signalMap?.get(`${key}:${context}`) || null;
}

function scoreClub({ club, signals, enrichment, quality, intent, weights }) {
  const originContext = intent.origin_context || "global";
  const accessSignal = getSignal(signals, "access_fit", originContext);
  const longSignal = getSignal(signals, "long_course_fit");
  const full18Signal = getSignal(signals, "full_18_fit");
  const beginnerSignal = getSignal(signals, "beginner_friendly");
  const wetSignal = getSignal(signals, "wet_weather_fit");
  const valueSignal = getSignal(signals, "value_fit");
  const bookingSignal = getSignal(signals, "booking_route_confidence");
  const availabilitySignal = getSignal(signals, "availability_confidence");
  const weekendSignal = getSignal(signals, "weekend_availability_fit");
  const fourballSignal = getSignal(signals, "fourball_fit");
  const paceSignal = getSignal(signals, "pace_of_play_proxy");

  const components = {
    access: signalScore(accessSignal, 50),
    length: signalScore(longSignal, 50),
    full18: signalScore(full18Signal, 50),
    beginner: signalScore(beginnerSignal, 50),
    wet: signalScore(wetSignal, 50),
    value: signalScore(valueSignal, 50),
    availability: signalScore(availabilitySignal, 35),
    weekend: signalScore(weekendSignal, 35),
    fourball: signalScore(fourballSignal, 45),
    pace: signalScore(paceSignal, 45),
    booking: signalScore(bookingSignal, 60),
    confidence: confidenceScore(quality?.overall_data_confidence || enrichment?.data_confidence),
  };

  let score = Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + (components[key] || 0) * weight;
  }, 0);

  const tradeoffCodes = [];
  const reasonCodes = [];

  if (intent.origin_context && accessSignal?.signal_value === "strong") {
    reasonCodes.push(`good_${intent.origin_context}_access`);
  }
  if (intent.origin_context && accessSignal?.signal_value === "weak") {
    tradeoffCodes.push(`weaker_${intent.origin_context}_access`);
    score -= 10;
  }
  if (intent.wants_longer_course && longSignal?.signal_value === "strong") reasonCodes.push("long_course_fit");
  if (intent.wants_full_18 && full18Signal?.signal_value === "strong") reasonCodes.push("full_18_fit");
  if (intent.wants_easy && beginnerSignal?.signal_value === "strong") reasonCodes.push("beginner_friendly");
  if (intent.wants_wet_weather && wetSignal?.signal_value === "strong") reasonCodes.push("wet_weather_fit");
  if (intent.wants_value && valueSignal?.signal_value === "strong") reasonCodes.push("strong_value");
  if (availabilitySignal?.signal_value === "strong" && availabilitySignal?.confidence !== "low") reasonCodes.push("fresh_availability");
  if (
    (intent.wants_weekend || intent.wants_low_crowding) &&
    weekendSignal?.signal_value === "strong" &&
    weekendSignal?.confidence !== "low"
  ) {
    reasonCodes.push("weekend_availability_fit");
  }
  if (intent.players && intent.players >= 4 && fourballSignal?.signal_value === "strong" && fourballSignal?.confidence !== "low") {
    reasonCodes.push("fourball_fit");
  }
  if (
    (intent.wants_pace || intent.wants_low_crowding) &&
    paceSignal?.signal_value === "strong" &&
    paceSignal?.confidence !== "low"
  ) {
    reasonCodes.push("pace_proxy_positive");
  }
  if (bookingSignal?.signal_value !== "weak") reasonCodes.push("booking_route_available");

  if ((intent.wants_weekend || intent.wants_low_crowding) && !weekendSignal) {
    tradeoffCodes.push("weekend_capacity_not_confirmed");
  }
  if (
    (intent.wants_weekend || intent.wants_low_crowding) &&
    weekendSignal?.signal_value === "weak" &&
    weekendSignal?.confidence !== "low"
  ) {
    tradeoffCodes.push("limited_weekend_availability");
  }
  if (intent.wants_low_crowding && !paceSignal) {
    tradeoffCodes.push("crowding_not_confirmed");
  }
  if (
    (intent.wants_pace || intent.wants_low_crowding) &&
    paceSignal?.signal_value === "weak" &&
    paceSignal?.confidence !== "low"
  ) {
    tradeoffCodes.push("pace_proxy_weak");
  }
  if (intent.wants_pace && !paceSignal) {
    tradeoffCodes.push("pace_not_confirmed");
  }
  if (intent.players && intent.players >= 4 && !fourballSignal) {
    tradeoffCodes.push("fourball_fit_proxy_only");
  }
  if (
    intent.players &&
    intent.players >= 4 &&
    fourballSignal?.signal_value !== "strong" &&
    fourballSignal?.confidence !== "low"
  ) {
    tradeoffCodes.push("fourball_availability_limited_or_proxy");
  }
  if (availabilitySignal?.confidence === "low") {
    tradeoffCodes.push("availability_stale_or_low_confidence");
  }
  if (quality?.overall_data_confidence === "low") {
    tradeoffCodes.push("low_data_confidence");
  }

  const match = clamp(Math.round(score));
  const proxyOnlyTradeoffs = new Set([
    "crowding_not_confirmed",
    "availability_stale_or_low_confidence",
    "fourball_availability_limited_or_proxy",
    "fourball_fit_proxy_only",
    "limited_weekend_availability",
    "pace_not_confirmed",
    "pace_proxy_weak",
    "weekend_capacity_not_confirmed",
  ]);
  const hasRequestedProxyGap = tradeoffCodes.some((code) => proxyOnlyTradeoffs.has(code));
  const recommendationConfidence =
    quality?.overall_data_confidence === "low"
      ? "low"
      : quality?.overall_data_confidence === "high" && tradeoffCodes.length <= 2 && !hasRequestedProxyGap
        ? "high"
        : "medium";

  return {
    club_id: club.id,
    club_name: club.club_name,
    location: club.location || null,
    match,
    recommendation_confidence: recommendationConfidence,
    reason_codes: Array.from(new Set(reasonCodes)).slice(0, 6),
    tradeoff_codes: Array.from(new Set(tradeoffCodes)).slice(0, 6),
    component_scores: components,
    data_confidence: quality?.overall_data_confidence || enrichment?.data_confidence || "unknown",
    decision_metadata: {
      access_context: intent.origin_context,
      access_score: components.access,
      length_score: components.length,
      value_score: components.value,
      wet_weather_score: components.wet,
      availability_score: components.availability,
      weekend_score: components.weekend,
      fourball_score: components.fourball,
      pace_score: components.pace,
      confidence_score: components.confidence,
    },
  };
}

function buildSummary(result) {
  const best = result.results[0];
  if (!best) return "No suitable recommendation could be produced.";

  const reasons = best.reason_codes
    .map((code) => code.replace(/_/g, " "))
    .slice(0, 3)
    .join(", ");
  const tradeoffs = best.tradeoff_codes
    .map((code) => code.replace(/_/g, " "))
    .slice(0, 2)
    .join(", ");

  return [
    `${best.club_name} is the current Best Pick at ${best.match}% match.`,
    reasons ? `Main reasons: ${reasons}.` : "",
    tradeoffs ? `Caution: ${tradeoffs}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
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

async function fetchClubs(supabase) {
  const attempts = [
    "id, club_name, location, postcode, latitude, longitude",
    "id, club_name, location, postcode",
    "id, club_name",
  ];

  let lastError = null;
  for (const select of attempts) {
    const { data, error } = await supabase.from("clubs").select(select);
    if (!error) return data || [];
    lastError = error;
  }
  throw new Error(`Failed to fetch clubs: ${lastError?.message || "unknown error"}`);
}

async function loadData(supabase) {
  const [clubs, signals, enrichments, qualityRows] = await Promise.all([
    fetchClubs(supabase),
    fetchAllRows(
      supabase,
      "club_decision_signals",
      "club_id, signal_key, signal_context, signal_value, signal_score, confidence, evidence, review_status"
    ),
    fetchAllRows(
      supabase,
      "club_agent_enrichment",
      "club_id, round_fit_tags, decision_strengths, tradeoff_flags, access_corridors, data_confidence, review_status"
    ),
    fetchAllRows(
      supabase,
      "round_agent_data_quality",
      "club_id, overall_data_confidence, missing_decision_fields, stale_decision_fields"
    ),
  ]);

  return {
    clubs,
    signalsByClub: groupSignals(signals),
    enrichmentByClub: new Map(enrichments.map((row) => [String(row.club_id), row])),
    qualityByClub: new Map(qualityRows.map((row) => [String(row.club_id), row])),
  };
}

function runCase(testCase, data, limit) {
  const intent = intentFromPrompt(testCase.prompt, testCase.context);
  const weights = buildWeights(intent);

  const scored = data.clubs
    .map((club) => {
      const clubId = String(club.id);
      return scoreClub({
        club,
        signals: data.signalsByClub.get(clubId) || new Map(),
        enrichment: data.enrichmentByClub.get(clubId) || null,
        quality: data.qualityByClub.get(clubId) || null,
        intent,
        weights,
      });
    })
    .sort((a, b) => b.match - a.match)
    .slice(0, limit);

  return {
    id: testCase.id,
    prompt: testCase.prompt,
    context: testCase.context,
    interpreted_intent: intent,
    weights,
    expectations: testCase.expectations || [],
    results: scored,
    summary: buildSummary({ results: scored }),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY.");
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
    realtime: { transport: WebSocket },
  });

  const data = await loadData(supabase);
  const cases = options.canonical
    ? CANONICAL_CASES
    : [
        {
          id: "custom_prompt",
          prompt: options.prompt,
          context: {
            source_surface: "browse",
            origin_context: options.originContext,
            origin_label: options.originContext.replace(/_/g, " "),
          },
          expectations: [],
        },
      ];

  const report = {
    generated_at: new Date().toISOString(),
    data_counts: {
      clubs: data.clubs.length,
      clubs_with_signals: data.signalsByClub.size,
      clubs_with_enrichment: data.enrichmentByClub.size,
      clubs_with_quality: data.qualityByClub.size,
    },
    cases: cases.map((testCase) => runCase(testCase, data, options.limit)),
  };

  fs.writeFileSync(path.resolve(options.output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
