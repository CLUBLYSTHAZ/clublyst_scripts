import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const clubsEnrichedPath = path.join(repoRoot, "src/data/clubs-enriched.json");
const shortCoursesPath = path.join(repoRoot, "src/data/short-courses-enriched.json");
const playabilityPath = path.join(repoRoot, "src/data/club_playability.json");
const hiddenClubsPath = path.join(repoRoot, "src/data/hidden-clubs.json");

const TABLE_NAME = "round_agent_editorial_evidence";
const MODEL = process.env.ROUND_AGENT_EVIDENCE_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEFAULT_STATUS = "pending_review";
const QUALITY_DIMENSIONS = [
  {
    id: "access_distance",
    label: "access/distance",
    claimPattern:
      /\b(access|accessible|nearby|near |close to|convenient|drive|driving|journey|minutes?|miles?|km|kilometres?|kilometers?|london|corridor|road|transport|train|station)\b/i,
    supportPattern:
      /\b(distanceKm|distanceMiles|origin|access_fit|travel_friction_fit|access_corridors|transport|road|station|postcode_origin_comparison|drive_minutes)\b/i,
  },
  {
    id: "crowding_pace",
    label: "crowding/pace",
    claimPattern:
      /\b(quiet|busy|crowded|crowds|slow|pace|waiting|waits|backups?|bunched|flow|quicker|quick round|drawn out)\b/i,
    supportPattern:
      /\b(pace_of_play_proxy|round_duration_risk|tee_time|tee_times|slots|availability|day_availability|pace|duration|crowding)\b/i,
  },
  {
    id: "terrain_scenery",
    label: "terrain/scenery",
    claimPattern:
      /\b(terrain|scenery|scenic|views?|tree-lined|woodland|heathland|links|parkland|downland|coastal|clifftop|water hazards?|elevation|valley|fells?|moorland)\b/i,
    supportPattern:
      /\b(terrain|scenery|verified_course_notes|course_notes|feel|condition_blurb|drainage|yardage|slope_rating|tee_used)\b/i,
  },
  {
    id: "service_facilities",
    label: "service/facilities",
    claimPattern:
      /\b(service|welcome|hospitality|restaurant|bar|clubhouse|range|practice|facilities|hotel|spa|society facilities)\b/i,
    supportPattern:
      /\b(practice|facilities|restaurant|bar|clubhouse|hotel|spa|tee_time_provider|membership_types|verified_course_notes|decision_strengths|round_fit_tags)\b/i,
  },
  {
    id: "conditions",
    label: "conditions",
    claimPattern:
      /\b(condition|conditioning|firm|soft|wet|dry|drainage|drains|winter|greens?|fairways?)\b/i,
    supportPattern:
      /\b(condition|condition_label|condition_blurb|drainage|wet_weather_fit|weather_impact_fit|enrichment_flagged|course_notes)\b/i,
  },
  {
    id: "quality_prestige",
    label: "quality/prestige",
    claimPattern:
      /\b(quality|premium|prestige|prestigious|top[- ]?100|championship|occasion|special|standout|best|strongest|polished)\b/i,
    supportPattern:
      /\b(top100|top_100|slope_rating|yardage|difficulty|green_fees|value_fit|long_course_fit|round_fit_tags|decision_strengths|course_notes)\b/i,
  },
];

const SYSTEM_PROMPT = `You write Round Agent evidence for Clublyst.

The output is not marketing copy. It is decision evidence used by a golf recommendation agent.

Rules:
- Use only supplied facts.
- Do not use reusable county templates.
- Do not say "proper club golf", "honest club golf", "straightforward", "hidden gem", or "friendly welcome".
- Every field must contain at least one concrete differentiator where the data supports it.
- If the data is thin or contradictory, be specific about what is known and avoid invented atmosphere.
- When source_facts.supabase.course.yardage exists, use source_facts.derived.yardage_length_band as the source of truth for course length language. Do not call a course short, medium, or long from playability.length_band if it conflicts with the yardage-derived band.
- Any claim about a quality dimension requires a matching fact in source_facts. Do not make access, distance, drive-time, London, corridor, convenience, crowding, terrain, scenery, service, pace, or conditioning claims unless source_facts explicitly includes supporting evidence for that dimension, such as distanceKm/distanceMiles from a named origin, access_fit/travel_friction_fit, access_corridors, nearby transport/road data, postcode-derived origin comparison, tee-time/pace signals, terrain data, condition data, facilities data, or verified course notes. If a dimension is not represented in source_facts, write around it rather than filling the gap with plausible general knowledge.
- Do not structure why_pick_agent as "claim + the data shows...".
- value_agent must make a comparative judgment. Do not restate the price as the whole point.
- Keep copy concise enough for a recommendation card.
- Return valid JSON only.`;

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

const args = process.argv.slice(2);
const isWrite = hasFlag(args, "--write");
const clubArg = argValue(args, "--clubs") || argValue(args, "--club");
const batchSize = Math.max(1, Number.parseInt(argValue(args, "--batch-size") || "50", 10) || 50);
const batchIndex = Math.max(0, Number.parseInt(argValue(args, "--batch-index") || "0", 10) || 0);
const useBrowseVisible = hasFlag(args, "--browse-visible") || !clubArg;

if (isWrite && hasFlag(args, "--dry-run")) {
  throw new Error("Use either --dry-run or --write, not both.");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeArrayData(input, keys = []) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(input[key])) return input[key];
  }
  return [];
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/['\u2019]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/^the\s+/g, "")
    .replace(
      /\b(golf club|golfcourse|golf course|country club|golf & country club|golf and country club|club and resort|resort|golf centre|golf center|hotel and spa|hotel|spa|course)\b/g,
      ""
    )
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CLUB_NAME_CANONICAL_OVERRIDES = {
  "Breadsall Priory Country Club": "Breadsall Priory Golf Club",
  "Breadsall Priory Country Club (Championship Priory Course)":
    "Breadsall Priory Golf Club",
  "Breadsall Priory Country Club (Moorland Course)":
    "Breadsall Priory Golf Club",
  "Cams Hall Estate Golf Club (Creek Course)": "Cams Hall Estate Golf Club",
  "Cams Hall Estate Golf Club (Park Course)": "Cams Hall Estate Golf Club",
  "Carden Park (The Cheshire Course)": "Carden Park",
  "Carden Park (The Nicklaus Course)": "Carden Park",
  "Chelsfield Lakes Golf Centre (The Lakes)": "Chelsfield Lakes Golf Centre",
  "East Horton Golf Club (The Greenwood Course)": "East Horton Golf Club",
  "East Horton Golf Club (The Parkland Course)": "East Horton Golf Club",
  "Eaton Golf Club (Chester)": "Eaton Golf Club",
  "Forest of Arden Country Club (Aylesford Course)":
    "Forest of Arden Country Club",
  "Forest of Arden Country Club (Championship Arden Course)":
    "Forest of Arden Country Club",
  "Goswick Golf Links": "Goswick Golf Club",
  "Hampton Court Palace Golf Club": "Hampton Court Palace",
  "Holtye Golf Club": "Holtye",
  "Macdonald Hill Valley Hotel Golf & Country Club (Emerald Course)":
    "Macdonald Hill Valley Hotel Golf & Country Club",
  "Macdonald Portal Hotel, Golf & Spa (Arderne Course)":
    "Portal Golf & Country Club",
  "Macdonald Portal Hotel, Golf & Spa (Championship Course)":
    "Portal Golf & Country Club",
  "Macdonald Portal Hotel, Golf & Spa (Premier Course)":
    "Portal Golf & Country Club",
  "Macdonald Portal Hotel, Golf & Spa": "Portal Golf & Country Club",
  "Mannings Heath Golf & Wine Estate": "Mannings Heath",
  "Oakmere Golf Club (Admirals Course)": "Oakmere Golf Club",
  "Oakmere Golf Club (Commanders Course)": "Oakmere Golf Club",
  "Queen's Park Golf Club": "Queens Park Golf Club",
  "Rudding Park Golf Club (Hawtree Championship Course)":
    "Rudding Park Golf Club",
  "Sherfield Oaks Golf Club (Waterloo Course)": "Sherfield Oaks Golf Club",
  "Sherfield Oaks Golf Club (Wellington Course)": "Sherfield Oaks Golf Club",
  "St Enodoc Golf Club (Church Course)": "St Enodoc Golf Club",
  "St Enodoc Golf Club (Holywell Course)": "St Enodoc Golf Club",
  "St Mellion Golf Club (Kernow Course)": "St Mellion Golf Club",
  "St Mellion Golf Club (Nicklaus Course)": "St Mellion Golf Club",
  "Stonebridge Golf Club (Blythe Course)": "Stonebridge Golf Club",
  "Stonebridge Golf Club (Hampton Course)": "Stonebridge Golf Club",
  "Stonebridge Golf Club (Somers Course)": "Stonebridge Golf Club",
  Sweetwoods: "Sweetwoods Park Golf Club",
  "Tandridge Golf Club": "Tandridge",
  "The Oaks Golf Centre (9-Hole Short Course)": "The Oaks",
  "The Shire London (Academy Course)": "The Shire London",
  "The West Lancashire Golf Club": "West Lancashire Golf Club",
  "Woodbury Park Hotel & Golf Club (The Oaks)":
    "Woodbury Park Hotel & Golf Club",
};

const CLUB_NAME_ALIASES_BY_CANONICAL = Object.entries(
  CLUB_NAME_CANONICAL_OVERRIDES
).reduce((acc, [variantName, canonicalName]) => {
  if (!acc[canonicalName]) acc[canonicalName] = [];
  acc[canonicalName].push(variantName);
  return acc;
}, {});

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function getCanonicalClubName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return CLUB_NAME_CANONICAL_OVERRIDES[raw] || raw;
}

function normalizeClubName(name) {
  return getCanonicalClubName(name)
    .toLowerCase()
    .trim()
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+golf\s+club$/i, "")
    .replace(/\s+golf\s+and\s+country\s+club$/i, "")
    .replace(/\s+country\s+club$/i, "")
    .replace(/\s+golf\s+course$/i, "")
    .replace(/\s+golf\s+centre$/i, "")
    .replace(/\s+golf\s+center$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getClubNameAliases(name) {
  const canonicalName = getCanonicalClubName(name);
  if (!canonicalName) return [];

  return Array.from(
    new Set([
      canonicalName,
      ...(CLUB_NAME_ALIASES_BY_CANONICAL[canonicalName] || []),
      String(name || "").trim(),
    ])
  ).filter(Boolean);
}

function slugCandidates(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];

  const variants = [
    raw,
    raw.replace(/&/g, "and"),
    raw.replace(/\bthe\b/gi, ""),
    raw.replace(/\bgolf club\b/gi, ""),
    raw.replace(/\bgolf course\b/gi, ""),
    raw.replace(/\bcountry club\b/gi, ""),
    raw.replace(/\bgc\b/gi, ""),
  ];

  return Array.from(new Set(variants.map(slugify).filter(Boolean)));
}

function readJsonArrayIfExists(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const data = readJson(filePath);
  return Array.isArray(data) ? data : [];
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function loadHiddenClubNames() {
  return new Set(
    readJsonArrayIfExists(hiddenClubsPath)
      .map((name) => getCanonicalClubName(String(name || "").trim()))
      .filter(Boolean)
  );
}

function loadClubRouteMaps() {
  const hiddenClubNames = loadHiddenClubNames();
  const rows = [
    ...readJsonArrayIfExists(clubsEnrichedPath),
    ...readJsonArrayIfExists(shortCoursesPath),
  ].filter((row) => {
    const clubName = getCanonicalClubName(
      String(row?.["Club Name"] || row?.clubName || "").trim()
    );
    return clubName && !hiddenClubNames.has(clubName);
  });

  const clubsByName = new Map();
  for (const row of rows) {
    const rawName = String(row?.["Club Name"] || row?.clubName || "").trim();
    if (!rawName) continue;

    const clubName = getCanonicalClubName(rawName);
    if (!clubsByName.has(clubName)) {
      clubsByName.set(clubName, {
        clubName,
        canonicalSlug: slugify(clubName),
        county: String(row?.["Location (County)"] || row?.location || "").trim(),
        rawNames: new Set(),
      });
    }

    const club = clubsByName.get(clubName);
    club.rawNames.add(rawName);
    if (!club.county) {
      club.county = String(row?.["Location (County)"] || row?.location || "").trim();
    }
  }

  const canonicalBySlug = new Map();
  const lookupBySlug = new Map();
  for (const club of clubsByName.values()) {
    canonicalBySlug.set(club.canonicalSlug, club);
    const names = new Set([
      club.clubName,
      ...club.rawNames,
      ...getClubNameAliases(club.clubName),
    ]);

    for (const name of names) {
      const candidates = [
        slugify(name),
        slugify(normalizeClubName(name)),
        ...slugCandidates(name),
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (!lookupBySlug.has(candidate)) lookupBySlug.set(candidate, club);
      }
    }
  }

  return {
    clubs: Array.from(clubsByName.values()),
    canonicalBySlug,
    lookupBySlug,
  };
}

function normalizeGreenFee(value) {
  const text = String(value ?? "").trim();
  if (!text || /^n\/?a$/i.test(text) || /^tbc$/i.test(text) || text === "-") {
    return "";
  }
  return text.replace(/^\u00a3/, "");
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function inferLengthBandFromYards(yardage) {
  const yards = toFiniteNumber(yardage);
  if (yards === null) return null;
  if (yards >= 6300) return "long";
  if (yards >= 5600) return "medium";
  return "short";
}

function buildStaticClubFacts(rows) {
  const byName = new Map();

  for (const row of rows) {
    const rawName = String(row?.["Club Name"] || row?.clubName || "").trim();
    if (!rawName) continue;

    const key = normalizeName(rawName);
    if (!key) continue;

    const existing =
      byName.get(key) || {
        club_name: rawName,
        location: "",
        postcode: "",
        website: "",
        latitude: null,
        longitude: null,
        green_fees: new Set(),
        membership_types: new Set(),
        annual_fees: new Set(),
      };

    existing.location ||= String(row?.["Location (County)"] || row?.location || "").trim();
    existing.postcode ||= String(row?.Postcode || row?.postcode || "").trim();
    existing.website ||= String(row?.["Website/Source Link"] || row?.website || "").trim();
    existing.latitude ??= toFiniteNumber(row?.latitude);
    existing.longitude ??= toFiniteNumber(row?.longitude);

    const greenFee = normalizeGreenFee(row?.["Pay & Play"] ?? row?.payAndPlay);
    if (greenFee) existing.green_fees.add(greenFee);

    const membershipType = String(row?.["Membership Type"] || "").trim();
    if (membershipType) existing.membership_types.add(membershipType);

    const annualFee = toFiniteNumber(row?.["Annual Fee (£)"]);
    if (annualFee !== null) existing.annual_fees.add(annualFee);

    byName.set(key, existing);
  }

  return byName;
}

function buildPlayabilityFacts(data) {
  const byName = new Map();
  for (const row of normalizeArrayData(data, ["clubs"])) {
    const key = normalizeName(row?.name);
    if (!key) continue;
    byName.set(key, {
      difficulty: row?.difficulty || null,
      length_band: row?.lengthBand || null,
      holes: row?.holes || null,
    });
  }
  return byName;
}

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }

  return createClient(supabaseUrl, serviceKey, {
    realtime: {
      enabled: false,
      transport: ws,
    },
  });
}

async function assertEvidenceTableExists(supabase) {
  const { error } = await supabase
    .from(TABLE_NAME)
    .select("club_id")
    .limit(1);

  if (error) {
    throw new Error(
      `${TABLE_NAME} is not queryable. Create/apply the migration before running this script. Supabase said: ${error.message}`
    );
  }
}

async function loadSupabaseClubs(supabase) {
  const { data, error } = await supabase
    .from("clubs")
    .select("id, club_name, location, postcode, website, latitude, longitude, tee_time_provider");

  if (error) throw new Error(`Failed to load clubs: ${error.message}`);
  return data || [];
}

async function loadSupabaseFactsByClubId(supabase, clubIds) {
  if (!clubIds.length) return new Map();

  const [courseResult, signalResult, enrichmentResult] = await Promise.all([
    supabase
      .from("course_enrichment")
      .select("club_id, holes, par, yardage, slope_rating, tee_used, enrichment_flagged")
      .in("club_id", clubIds),
    supabase
      .from("club_decision_signals")
      .select("club_id, signal_key, signal_value, signal_score, confidence")
      .in("club_id", clubIds),
    supabase
      .from("club_agent_enrichment")
      .select("club_id, round_fit_tags, decision_strengths, tradeoff_flags, access_corridors, data_confidence")
      .in("club_id", clubIds),
  ]);

  if (courseResult.error) {
    throw new Error(`Failed to load course_enrichment: ${courseResult.error.message}`);
  }
  if (signalResult.error) {
    throw new Error(`Failed to load club_decision_signals: ${signalResult.error.message}`);
  }
  if (enrichmentResult.error) {
    throw new Error(`Failed to load club_agent_enrichment: ${enrichmentResult.error.message}`);
  }

  const byClubId = new Map();
  for (const clubId of clubIds) {
    byClubId.set(String(clubId), {
      course: null,
      signals: [],
      enrichment: null,
    });
  }

  for (const row of courseResult.data || []) {
    const entry = byClubId.get(String(row.club_id));
    if (entry && !entry.course) entry.course = row;
  }
  for (const row of signalResult.data || []) {
    const entry = byClubId.get(String(row.club_id));
    if (entry) entry.signals.push(row);
  }
  for (const row of enrichmentResult.data || []) {
    const entry = byClubId.get(String(row.club_id));
    if (entry && !entry.enrichment) entry.enrichment = row;
  }

  return byClubId;
}

async function loadProcessedClubIds(supabase, clubIds) {
  if (!clubIds.length) return new Set();

  const processed = new Set();
  for (let index = 0; index < clubIds.length; index += 100) {
    const batch = clubIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("club_id")
      .in("club_id", batch);

    if (error) {
      throw new Error(`Failed to load existing ${TABLE_NAME} rows: ${error.message}`);
    }

    for (const row of data || []) {
      if (row?.club_id) processed.add(String(row.club_id));
    }
  }

  return processed;
}

function serialiseStaticFacts(facts) {
  if (!facts) return null;
  return {
    club_name: facts.club_name,
    location: facts.location || null,
    postcode: facts.postcode || null,
    website: facts.website || null,
    latitude: facts.latitude,
    longitude: facts.longitude,
    green_fees: Array.from(facts.green_fees),
    membership_types: Array.from(facts.membership_types),
    annual_fees: Array.from(facts.annual_fees).sort((a, b) => a - b),
  };
}

function serialiseSupabaseFacts(facts) {
  if (!facts) return null;
  return {
    course: facts.course || null,
    signals: facts.signals || [],
    enrichment: facts.enrichment || null,
  };
}

function compactSourceFacts({ staticFacts, playabilityFacts, supabaseFacts }) {
  const yardage = toFiniteNumber(supabaseFacts?.course?.yardage);
  const yardageLengthBand = inferLengthBandFromYards(yardage);
  const derived = {
    yardage,
    yardage_length_band: yardageLengthBand,
    playability_length_band_conflict:
      Boolean(yardageLengthBand && playabilityFacts?.length_band) &&
      yardageLengthBand !== playabilityFacts.length_band,
  };

  return {
    static: serialiseStaticFacts(staticFacts),
    playability: playabilityFacts || null,
    supabase: serialiseSupabaseFacts(supabaseFacts),
    derived,
  };
}

function buildPrompt({ clubName, sourceFacts }) {
  return `Create Round Agent editorial evidence for ${clubName}.

Known source facts:
${JSON.stringify(sourceFacts, null, 2)}

Return JSON only:
{
  "club_name": "${clubName}",
  "best_for_agent": "",
  "why_pick_agent": "",
  "playing_feel_agent": "",
  "value_agent": "",
  "ideal_for_agent": "",
  "evidence_tags": [],
  "source_facts": {}
}`;
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("model response did not contain JSON");
    return JSON.parse(match[0]);
  }
}

function validateGeneratedRow(row, clubName, sourceFacts) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`${clubName}: response was not an object`);
  }
  for (const field of [
    "best_for_agent",
    "why_pick_agent",
    "playing_feel_agent",
    "value_agent",
    "ideal_for_agent",
  ]) {
    if (typeof row[field] !== "string" || !row[field].trim()) {
      throw new Error(`${clubName}: missing ${field}`);
    }
  }
  if (!Array.isArray(row.evidence_tags)) {
    throw new Error(`${clubName}: evidence_tags must be an array`);
  }

  return {
    club_name: String(row.club_name || clubName).trim(),
    best_for_agent: row.best_for_agent.trim(),
    why_pick_agent: row.why_pick_agent.trim(),
    playing_feel_agent: row.playing_feel_agent.trim(),
    value_agent: row.value_agent.trim(),
    ideal_for_agent: row.ideal_for_agent.trim(),
    evidence_tags: row.evidence_tags.map((tag) => String(tag || "").trim()).filter(Boolean),
    source_facts: sourceFacts,
    status: DEFAULT_STATUS,
    enrichment_source: "round_agent_ai_v1",
    model: MODEL,
    generated_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
  };
}

async function generateWithOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY must be set to generate preview content.");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("OpenAI response missing content");
  return extractJson(text);
}

function flattenForSupport(value) {
  return JSON.stringify(value || {});
}

function rowText(row) {
  return [
    row.best_for_agent,
    row.why_pick_agent,
    row.playing_feel_agent,
    row.value_agent,
    row.ideal_for_agent,
  ]
    .filter(Boolean)
    .join(" ");
}

function firstSentence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const match = text.match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : text).trim();
}

function normalizeOpening(value, clubName) {
  return firstSentence(value)
    .toLowerCase()
    .replace(new RegExp(`\\b${escapeRegExp(clubName.toLowerCase())}\\b`, "g"), "{club}")
    .replace(/\b[a-z][a-z\s'&.-]+?\b(?=\s+is\b)/, "{club}")
    .replace(/£\s?\d+(?:\s?[-–]\s?£?\d+)?/g, "£x")
    .replace(/\b\d+\b/g, "n")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikePriceOnlyValue(row) {
  const value = String(row.value_agent || "").trim();
  if (!value) return false;
  const withoutPrices = value
    .replace(/£\s?\d+(?:\s?[-–]\s?£?\d+)?/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/[.,;:()\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const comparative =
    /\b(cheaper|costlier|premium|budget|value|relative|compared|against|because|for a full|for 18|entry|strong|fair|weaker|better|less|more|area|county|set|comparable)\b/i.test(
      value
    );
  return withoutPrices.length < 32 || !comparative;
}

function lintLengthContradiction(row) {
  const yardage = toFiniteNumber(row.source_facts?.derived?.yardage);
  const yardageLengthBand = row.source_facts?.derived?.yardage_length_band;
  if (!yardage || !yardageLengthBand) return null;

  const text = rowText(row).toLowerCase();
  if (
    yardageLengthBand === "long" &&
    /\b(short|shorter|compact|not a long hitter|not a long hitter's|not a long hitters)\b/.test(text)
  ) {
    return `yardage is ${yardage} (${yardageLengthBand}) but copy uses short-course language`;
  }

  if (
    yardageLengthBand === "short" &&
    /\b(long|longer|full-length|long hitter|long hitters)\b/.test(text)
  ) {
    return `yardage is ${yardage} (${yardageLengthBand}) but copy uses long-course language`;
  }

  return null;
}

function lintRows(rows) {
  const flags = [];
  const openingByKey = new Map();

  for (const row of rows) {
    const supportText = flattenForSupport(row.source_facts);
    const text = rowText(row);

    for (const dimension of QUALITY_DIMENSIONS) {
      if (dimension.claimPattern.test(text) && !dimension.supportPattern.test(supportText)) {
        flags.push({
          club_name: row.club_name,
          check: "unsupported_quality_claim",
          detail: dimension.label,
        });
      }
    }

    if (/\bthe data shows\b/i.test(row.why_pick_agent)) {
      flags.push({
        club_name: row.club_name,
        check: "template_structure",
        detail: 'why_pick_agent uses "the data shows"',
      });
    }

    if (looksLikePriceOnlyValue(row)) {
      flags.push({
        club_name: row.club_name,
        check: "weak_value_agent",
        detail: "value_agent appears to restate price without a comparative judgment",
      });
    }

    const lengthContradiction = lintLengthContradiction(row);
    if (lengthContradiction) {
      flags.push({
        club_name: row.club_name,
        check: "length_contradiction",
        detail: lengthContradiction,
      });
    }

    const opening = normalizeOpening(row.why_pick_agent, row.club_name);
    if (!openingByKey.has(opening)) openingByKey.set(opening, []);
    openingByKey.get(opening).push(row.club_name);
  }

  for (const [opening, clubNames] of openingByKey.entries()) {
    if (clubNames.length < 2) continue;
    for (const clubName of clubNames) {
      flags.push({
        club_name: clubName,
        check: "repeated_opening",
        detail: opening,
      });
    }
  }

  return flags;
}

function buildTargetClubs({ routeMaps, staticFactsByName }) {
  if (clubArg) {
    return clubArg
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((requestedName) => {
        const routeClub = routeMaps.lookupBySlug.get(slugify(requestedName));
        return {
          clubName: routeClub?.clubName || requestedName,
          canonicalSlug: routeClub?.canonicalSlug || slugify(requestedName),
        };
      });
  }

  return routeMaps.clubs.filter((club) => {
    const facts = staticFactsByName.get(normalizeName(club.clubName));
    return facts && facts.green_fees.size > 0;
  });
}

function sliceBatch(items) {
  const start = batchIndex * batchSize;
  return {
    start,
    end: Math.min(items.length, start + batchSize),
    items: items.slice(start, start + batchSize),
  };
}

async function upsertGeneratedRows(supabase, rows) {
  if (!rows.length) return;
  const payload = rows.map((row) => ({
    club_id: row.club_id,
    club_name: row.club_name,
    best_for_agent: row.best_for_agent,
    why_pick_agent: row.why_pick_agent,
    playing_feel_agent: row.playing_feel_agent,
    value_agent: row.value_agent,
    ideal_for_agent: row.ideal_for_agent,
    evidence_tags: row.evidence_tags,
    source_facts: row.source_facts,
    enrichment_source: row.enrichment_source,
    model: row.model,
    generated_at: row.generated_at,
    status: DEFAULT_STATUS,
    reviewed_at: null,
    reviewed_by: null,
  }));

  const { error } = await supabase
    .from(TABLE_NAME)
    .upsert(payload, { onConflict: "club_id" });

  if (error) throw new Error(`Failed to upsert ${TABLE_NAME}: ${error.message}`);
}

function printBatchSummary({ mode, totalTargets, batch, generatedRows, skipped, failed, flags }) {
  const nextBatchIndex = batchIndex + 1;
  const hasNextBatch = batch.end < totalTargets;
  const summary = {
    mode,
    table: TABLE_NAME,
    batch_index: batchIndex,
    batch_size: batchSize,
    batch_range: {
      start: batch.start,
      end: batch.end,
      total_targets: totalTargets,
    },
    generated_count: generatedRows.length,
    skipped_count: skipped.length,
    failed_count: failed.length,
    lint_flag_count: flags.length,
    skipped,
    failed,
    lint_flags: flags,
    next_command: hasNextBatch
      ? `node scripts/round-agent/generate-editorial-evidence.mjs ${useBrowseVisible ? "--browse-visible" : `--clubs "${clubArg}"`} --batch-size ${batchSize} --batch-index ${nextBatchIndex}${isWrite ? " --write" : " --dry-run"}`
      : null,
  };

  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const supabase = getSupabaseClient();
  await assertEvidenceTableExists(supabase);

  const routeMaps = loadClubRouteMaps();
  const staticRows = [
    ...normalizeArrayData(readJsonIfExists(clubsEnrichedPath, []), ["clubs", "rows", "data", "items"]),
    ...normalizeArrayData(readJsonIfExists(shortCoursesPath, []), ["clubs", "rows", "data", "items"]),
  ];
  const staticFactsByName = buildStaticClubFacts(staticRows);
  const playabilityByName = buildPlayabilityFacts(readJsonIfExists(playabilityPath, []));
  const targetClubs = buildTargetClubs({ routeMaps, staticFactsByName });
  const batch = sliceBatch(targetClubs);

  if (!batch.items.length) {
    console.log(
      JSON.stringify(
        {
          mode: isWrite ? "write" : "dry-run",
          table: TABLE_NAME,
          batch_index: batchIndex,
          batch_size: batchSize,
          message: "No clubs in this batch.",
        },
        null,
        2
      )
    );
    return;
  }

  const supabaseClubs = await loadSupabaseClubs(supabase);
  const supabaseClubByName = new Map();
  for (const club of supabaseClubs) {
    const key = normalizeName(club.club_name);
    if (key && !supabaseClubByName.has(key)) supabaseClubByName.set(key, club);
  }

  const batchWithIds = batch.items
    .map((club) => {
      const supabaseClub = supabaseClubByName.get(normalizeName(club.clubName));
      return {
        ...club,
        supabaseClub,
        clubId: supabaseClub?.id ? String(supabaseClub.id) : null,
      };
    })
    .filter((club) => club.clubId);

  const missingIds = batch.items
    .filter((club) => !supabaseClubByName.get(normalizeName(club.clubName))?.id)
    .map((club) => ({
      club_name: club.clubName,
      reason: "no matching Supabase club_id",
    }));

  const clubIds = batchWithIds.map((club) => club.clubId);
  const processedClubIds = await loadProcessedClubIds(supabase, clubIds);
  const supabaseFactsByClubId = await loadSupabaseFactsByClubId(supabase, clubIds);
  const generatedRows = [];
  const skipped = [...missingIds];
  const failed = [];

  for (const club of batchWithIds) {
    if (processedClubIds.has(club.clubId)) {
      skipped.push({
        club_name: club.clubName,
        club_id: club.clubId,
        reason: `existing ${TABLE_NAME} row`,
      });
      continue;
    }

    const key = normalizeName(club.clubName);
    const sourceFacts = compactSourceFacts({
      staticFacts: staticFactsByName.get(key),
      playabilityFacts: playabilityByName.get(key),
      supabaseFacts: {
        club: club.supabaseClub,
        ...(supabaseFactsByClubId.get(club.clubId) || {}),
      },
    });

    try {
      const prompt = buildPrompt({
        clubName: club.clubName,
        sourceFacts,
      });
      const generated = await generateWithOpenAI(prompt);
      const validated = validateGeneratedRow(generated, club.clubName, sourceFacts);
      generatedRows.push({
        ...validated,
        club_id: club.clubId,
      });
    } catch (error) {
      failed.push({
        club_name: club.clubName,
        club_id: club.clubId,
        reason: error.message,
      });
    }
  }

  const flags = lintRows(generatedRows);

  if (isWrite) {
    await upsertGeneratedRows(supabase, generatedRows);
  }

  console.log(
    JSON.stringify(
      {
        dry_run: !isWrite,
        destination: TABLE_NAME,
        previews: generatedRows,
      },
      null,
      2
    )
  );
  printBatchSummary({
    mode: isWrite ? "write" : "dry-run",
    totalTargets: targetClubs.length,
    batch,
    generatedRows,
    skipped,
    failed,
    flags,
  });
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
