# Clublyst Round Agent Beta

## AI-Led Decision Data Layer Addendum — R1

**Status:** Proposed addition to Round Agent Beta R1

---

# 1. Product Requirement

Round Agent will only be accurate and compelling if it is powered by richer decision data than basic price, distance and booking links.

R1 must therefore include an **AI-led structured decision data layer**.

The goal is:

> **Use AI to enrich Clublyst's course data into structured, inspectable decision signals before recommendation time.**

Round Agent should not rely on the LLM to invent persuasive course judgements during a user request.

Instead:

1. Clublyst data is enriched into structured decision signals.
2. Signals are stored in Supabase with evidence and confidence.
3. Round Agent ranks courses deterministically using those signals.
4. The LLM may explain the already-grounded recommendation concisely.

---

# 2. Core Principle

## AI helps prepare the data. Clublyst logic makes the recommendation.

Bad R1 outcome:

```text
User asks for a round
↓
LLM reads thin fields
↓
LLM writes confident-sounding recommendation
```

Required R1 outcome:

```text
AI-assisted enrichment
↓
Structured decision signals in Supabase
↓
Deterministic Round Agent ranking
↓
Grounded explanation from reason codes and trusted signals
```

The LLM must not create unsupported course facts at response time.

---

# 3. AI-Led Decision Signals

R1 should create or consume structured decision signals that help Round Agent answer:

> **Which course is best for this golfer's round?**

Suggested signal groups:

## Round Fit

```text
beginner_friendly
quick_9
full_18
society_group_friendly
wet_weather_option
value_round
premium_round
challenge_round
casual_visitor_friendly
```

## Decision Strengths

```text
strong_value
good_winter_playability
good_drainage
forgiving_layout
interesting_layout
easy_online_booking
worth_the_drive
good_for_higher_handicaps
good_for_confident_golfers
good_for_budget_round
good_for_quality_round
```

## Trade-Off Flags

```text
limited_data_confidence
harder_than_average
longer_drive
premium_price
value_less_clear
availability_not_confirmed
conditions_stale
booking_friction
not_ideal_in_wet
limited_visitor_information
```

These should be stored as structured fields or arrays, not only as prose.

---

# 4. Evidence and Confidence

Every AI-led decision signal should include enough metadata to inspect why it exists.

For each signal, persist where practical:

```text
signal_key
signal_value
confidence
evidence_fields
source_type
source_updated_at
generated_at
needs_review
```

Confidence values:

```text
high
medium
low
```

Example:

```json
{
  "signal_key": "beginner_friendly",
  "signal_value": "high",
  "confidence": "medium",
  "evidence_fields": {
    "difficulty": "easy",
    "length_band": "short",
    "pay_and_play": true,
    "booking_url_known": true
  },
  "source_type": "clublyst_structured_data",
  "needs_review": false
}
```

Round Agent may use medium-confidence signals, but should avoid overclaiming them.

Low-confidence signals should usually affect recommendation confidence rather than create bold user-facing claims.

---

# 5. Supabase Requirement

The AI-led data layer must be available in Supabase.

Recommended tables:

```text
club_decision_signals
club_agent_enrichment
round_agent_data_quality
```

Exact names may follow existing Clublyst conventions.

## `club_decision_signals`

Purpose:

Store structured per-club decision signals used by Round Agent.

Suggested fields:

```text
id uuid primary key
club_id uuid not null

signal_key text not null
signal_value text not null
confidence text not null

evidence jsonb
source_type text
source_version text nullable
source_updated_at timestamptz nullable

generated_by text
generated_at timestamptz
review_status text
reviewed_at timestamptz nullable

created_at timestamptz
updated_at timestamptz
```

Recommended uniqueness:

```text
unique (club_id, signal_key)
```

## `club_agent_enrichment`

Purpose:

Store higher-level Round Agent enrichment summaries per club.

Suggested fields:

```text
club_id uuid primary key

round_fit_tags text[]
decision_strengths text[]
tradeoff_flags text[]

best_for text[]
avoid_if text[]

agent_summary text nullable
summary_confidence text

data_confidence text
needs_review boolean
review_reason text nullable

generated_at timestamptz
updated_at timestamptz
```

`agent_summary` must be grounded in stored signals and should not introduce unsupported facts.

## `round_agent_data_quality`

Purpose:

Track whether each club has enough reliable data to support compelling Round Agent recommendations.

Suggested fields:

```text
club_id uuid primary key

has_price_data boolean
has_value_signal boolean
has_conditions_data boolean
has_difficulty_data boolean
has_booking_data boolean
has_location_data boolean
has_tee_time_data boolean

condition_freshness text nullable
tee_time_freshness text nullable
price_freshness text nullable

overall_data_confidence text
missing_decision_fields text[]
stale_decision_fields text[]

updated_at timestamptz
```

---

# 6. Freshness Thresholds

R1 must define concrete freshness rules before launch.

Recommended starting point:

```text
tee_time_fresh = updated within 28 hours
conditions_fresh = updated within 7 days
conditions_stale = older than 14 days
price_fresh = source reviewed within 90 days where timestamp exists
booking_fresh = booking URL verified within 90 days where timestamp exists
```

If no timestamp exists, the field may still be used, but confidence should reflect that freshness is unknown.

Round Agent must not claim "available today", "good conditions", or similar time-sensitive statements unless the supporting data is fresh enough for that claim.

---

# 7. How Round Agent Uses AI-Led Data

At recommendation time, Round Agent should combine:

```text
user intent
+
location/page context
+
existing Clublyst data
+
club_decision_signals
+
club_agent_enrichment
+
round_agent_data_quality
```

The deterministic ranking engine should use decision signals as ranking features.

Examples:

```text
User asks: "not too hard"
Boost: beginner_friendly, forgiving_layout, easy_difficulty
Penalise: harder_than_average, difficulty_above_preference
```

```text
User asks: "good if it rains"
Boost: wet_weather_option, good_drainage, good_winter_playability
Penalise: not_ideal_in_wet, conditions_stale
```

```text
User asks: "best value"
Boost: strong_value, value_round, good_for_budget_round
Penalise: premium_price, value_less_clear
```

---

# 8. User-Facing Explanation Rules

Round Agent may explain stored AI-led signals only when they are supported by evidence and confidence.

Prefer:

```text
Good fit if you want an easier round: moderate difficulty, shorter layout and strong value.
```

Avoid:

```text
This is a welcoming, relaxing course with great greens and a friendly atmosphere.
```

unless Clublyst has reliable structured data supporting those claims.

User-facing explanations should be assembled from:

```text
reason_codes
tradeoff_codes
trusted Clublyst fields
stored decision signals
decision_metadata
```

---

# 9. R1 Enrichment Generation

R1 may generate the AI-led data layer through an offline or server-side process.

Acceptable sources:

```text
existing Clublyst structured course data
conditions data
tee-time data
booking data
pricing data
course playability data
location/distance-derived features
existing editorial/enrichment summaries where structured enough
```

Out of scope:

```text
autonomous live web research
automatic modification of core club facts
unreviewed external claims
AI-generated editorial reviews
```

If AI enrichment uses editorial text or summaries, it must extract structured signals and confidence rather than creating new freeform marketing copy.

---

# 10. Review and Data Quality

AI-led signals should be reviewable.

Signals should be flagged for review when:

```text
confidence = low
evidence is thin
source data conflicts
time-sensitive data is stale
signal materially affects recommendation ranking
```

R1 does not require an admin dashboard, but Supabase debug queries should allow inspection of:

```text
low-confidence signals
clubs missing decision signals
most common decision strengths
most common tradeoff flags
clubs with stale conditions/tee-time signals
clubs most frequently recommended because of AI-led signals
```

---

# 11. Acceptance Criteria Additions

Add these to the Round Agent R1 acceptance criteria:

```text
[ ] Round Agent has access to AI-led structured decision data in Supabase.
[ ] Decision signals are stored per club with confidence and evidence.
[ ] Round fit tags are available for recommendation ranking.
[ ] Decision strengths and trade-off flags are available for recommendation ranking.
[ ] Data-quality confidence is available per club.
[ ] Freshness thresholds are defined for time-sensitive fields.
[ ] Round Agent never uses AI-led signals to make unsupported course claims.
[ ] Low-confidence signals reduce recommendation certainty or require review.
[ ] User-facing explanations are grounded in stored signals and reason codes.
[ ] Supabase debug queries can inspect decision signals and data-quality issues.
```

---

# 12. Final Requirement

Round Agent R1 should not merely add an AI input box.

It must create a new decision-intelligence layer:

```text
AI-led structured enrichment
↓
Supabase decision signals
↓
Deterministic recommendation
↓
Grounded explanation
↓
Measurable booking/referral behaviour
```

This is what makes the feature accurate, inspectable and compelling.
