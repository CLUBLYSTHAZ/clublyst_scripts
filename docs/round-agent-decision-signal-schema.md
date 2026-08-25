# Round Agent Decision-Signal Schema

**Status:** Companion reference for migration  
**Migration:** `supabase/migrations/20260825_round_agent_decision_signal_schema.sql`

---

# 1. What This Schema Is For

This schema gives Round Agent a flexible Supabase data layer for premium decision intelligence.

It is designed so we can add new agent signals without adding a new database column every time.

Core tables:

```text
club_decision_signals
club_agent_enrichment
round_agent_data_quality
```

---

# 2. Table Roles

## `club_decision_signals`

Fine-grained per-club signals.

Use this for inspectable ranking features:

```text
long_course_fit
wet_weather_fit
access_fit
fourball_fit
pace_of_play_proxy
weekend_capacity_proxy
value_fit
```

Each row includes:

```text
signal_key
signal_context
signal_value
signal_score
confidence
evidence
source_type
review_status
```

## `club_agent_enrichment`

Fast per-club summary for Round Agent reads.

Use this for:

```text
round_fit_tags
decision_strengths
tradeoff_flags
access_corridors
best_for
avoid_if
data_confidence
```

## `round_agent_data_quality`

Per-club readiness/confidence view.

Use this to decide how confidently Round Agent can recommend or explain a course.

---

# 3. First Signals To Populate

Prioritise these before the Browse UI is built.

## Access Signals

```text
access_fit
access_corridor
cross_city_penalty
route_friction
```

Example:

```json
{
  "signal_key": "access_fit",
  "signal_context": "south_west_london",
  "signal_value": "strong",
  "signal_score": 86,
  "confidence": "medium",
  "evidence": {
    "county": "Surrey",
    "origin_model": "london_sub_region_v1",
    "cross_city_penalty": false
  }
}
```

## Course Fit Signals

```text
long_course_fit
full_18_fit
quick_9_fit
beginner_friendly
challenge_round
forgiving_layout
```

Example:

```json
{
  "signal_key": "long_course_fit",
  "signal_context": "global",
  "signal_value": "medium",
  "signal_score": 68,
  "confidence": "high",
  "evidence": {
    "length_band": "medium",
    "holes": 18
  }
}
```

## Group And Weekend Signals

```text
fourball_fit
weekend_capacity_proxy
pace_of_play_proxy
weekend_crowding_risk
```

Example:

```json
{
  "signal_key": "fourball_fit",
  "signal_context": "weekend",
  "signal_value": "medium",
  "signal_score": 62,
  "confidence": "low",
  "evidence": {
    "has_weekend_slots": true,
    "slots_next_3_days": 8,
    "pace_directly_measured": false
  }
}
```

Important:

These are proxy signals. They must not be turned into claims like "quiet at weekends" unless direct data exists.

## Conditions Signals

```text
wet_weather_fit
good_drainage
winter_playability
condition_freshness
```

Example:

```json
{
  "signal_key": "wet_weather_fit",
  "signal_context": "global",
  "signal_value": "positive",
  "signal_score": 74,
  "confidence": "medium",
  "evidence": {
    "drainage_bucket": "D1",
    "condition_label": "Playable",
    "condition_updated_at": "2026-08-21T13:35:36.551Z"
  }
}
```

## Value And Quality Signals

```text
value_fit
budget_round_fit
premium_round_fit
worth_the_drive
quality_relative_to_price
```

Example:

```json
{
  "signal_key": "value_fit",
  "signal_context": "global",
  "signal_value": "strong",
  "signal_score": 82,
  "confidence": "medium",
  "evidence": {
    "price_min": 34,
    "relative_local_price_percentile": 0.72,
    "condition_score_10": 5.4,
    "length_band": "medium"
  }
}
```

---

# 4. Review Status

Use:

```text
auto_approved
needs_review
approved
rejected
retired
```

Public read policies expose only:

```text
auto_approved
approved
```

Use `needs_review` for signals that may affect recommendations but are not safe for user-facing claims yet.

---

# 5. Confidence Guidance

Use `high` when the signal comes from strong structured evidence.

Use `medium` when the signal is a reasonable derived inference.

Use `low` when the signal is a weak proxy, stale, or incomplete.

Low-confidence signals should:

```text
reduce recommendation confidence
avoid bold user-facing claims
trigger review where material
```

---

# 6. Claims Policy

Safe:

```text
better south-west London access
stronger four-ball fit
better weekend capacity proxy
pace not confirmed
medium availability confidence
```

Unsafe unless directly supported:

```text
quiet at weekends
fast rounds guaranteed
rounds under four hours
always good for groups
excellent greens
friendly atmosphere
```

---

# 7. Recommended First Backfill

First deterministic backfill should generate signals from current data:

```text
price_min / price_max
lat/lon/county/postcode
booking provider
condition label/score/drainage bucket
holes/length/difficulty
tee-time summary/freshness
top100London
```

Then populate:

```text
long_course_fit
full_18_fit
beginner_friendly
wet_weather_fit
value_fit
booking_route_confidence
availability_confidence
access_corridor
access_fit
round_agent_data_quality
```

Second pass should add the more premium proxy signals:

```text
fourball_fit
weekend_capacity_proxy
pace_of_play_proxy
worth_the_drive
quality_relative_to_price
