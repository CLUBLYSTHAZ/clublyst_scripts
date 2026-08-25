# Clublyst Round Agent

## Current Data Audit

**Status:** Planning audit  
**Date:** 2026-08-25  
**First beta surface:** Browse/results only

---

# 1. Executive Summary

Clublyst already has enough structured data to support a grounded first version of Round Agent on Browse, but not enough to make it feel premium without an additional decision-signal layer.

## Strong Current Data

Ready or close to ready:

```text
club identity
county/location
postcode
lat/lon
visitor price ranges
direct booking URLs
booking provider inference
live condition labels/scores
drainage/playability condition inputs
course length/difficulty/holes from playability data
tee-time summaries where available
existing AI/freeform ranking utilities
```

## Main Data Gaps

Need new derived or AI-led decision signals:

```text
practical access corridors
London sub-region access logic
cross-city penalty
four-ball/group fit
weekend capacity proxy
pace-of-play proxy
weekend crowding risk
worth-the-drive fit
premium/value decision classification
data-quality confidence by club
```

The agent can be accurate with current data, but it will not feel genuinely intelligent until those gaps are addressed.

---

# 2. Current Coverage Snapshot

Based on local static data and app utilities inspected on 2026-08-25.

| Area | Current Coverage / Evidence | Readiness |
|---|---:|---|
| Main enriched club rows | `4041` rows in `src/data/clubs-enriched.json` | Ready |
| Unique main clubs | `535` unique club names | Ready |
| Lat/lon | `535` unique clubs with latitude/longitude | Ready |
| Pay & play pricing | `535` unique clubs with Pay & Play values | Ready |
| Website/source link | `528` unique clubs with source link | Mostly ready |
| Booking URL rows | `533` rows in booking URL JSON | Ready |
| Non-call booking URLs | `522` rows | Mostly ready |
| Static playability rows | `524` clubs in `src/data/club_playability.json` | Ready |
| Short-course enrichment | `16` rows, all with `coursePlayability` | Ready for short-course detection |
| Live condition rows | `518` rows in `src/data/course-conditions-live.json` | Ready |
| Top 100 London marker | `87` unique clubs marked `top100London` | Useful quality proxy |

Important nuance:

`src/data/clubs-enriched.json` has almost no embedded `coursePlayability`, but the app uses dedicated playability sources:

```text
src/data/club_playability.json
src/data/short-courses-enriched.json
course_enrichment_public from Supabase
```

So course length/difficulty should be considered available, but the Round Agent data layer should normalise these sources into a single decision-signal view.

---

# 3. Existing Data Sources

## Static Club Data

Primary file:

```text
src/data/clubs-enriched.json
```

Useful fields:

```text
Club Name
Location (County)
Postcode
Pay & Play
Website/Source Link
latitude
longitude
top100London
```

Current usefulness:

* strong basis for identity, county, location and pricing
* good enough for Browse candidate retrieval
* not enough for nuanced decision fit by itself

## Booking Data

Primary file:

```text
src/data/London Golf Memberships - Booking URLs.json
```

Supporting utilities:

```text
src/utils/bookingUrlMapping.ts
src/utils/bookingProvider.ts
src/utils/logBookingClick.ts
```

Current usefulness:

* Clublyst has direct booking routes for clubs
* booking route existence should be treated as baseline, not a major differentiator
* provider/page type can support route confidence and attribution

Recommended Round Agent use:

```text
booking_route_confidence
booking_provider
booking_page_type
availability_confidence
```

Avoid over-ranking clubs just because a booking URL exists.

## Conditions Data

Primary file:

```text
src/data/course-conditions-live.json
```

Supporting utilities:

```text
src/utils/conditionProfile.ts
src/utils/playability.ts
src/utils/conditionsLive.ts
```

Useful fields:

```text
condition_label
condition_blurb
condition_score_10
moisture_score_10
moisture_label
drainage_bucket
estimated_drainage_bucket
soil_type
elevation_m
metrics
updated_at
source
```

Current usefulness:

* strong enough for conditions-focused ranking
* good foundation for wet-weather and drainage signals
* freshness must be enforced before making time-sensitive claims

Recommended derived signals:

```text
wet_weather_fit
good_drainage
winter_playability
condition_freshness
condition_confidence
```

## Course Playability Data

Primary files/utilities:

```text
src/data/club_playability.json
src/data/short-courses-enriched.json
src/utils/playabilityUtils.ts
src/utils/courseEnrichment.ts
```

Useful fields:

```text
holes
difficulty
lengthBand
yardage
slope_rating
tee_used
```

Current usefulness:

* strong enough for "longer course", "not too hard", "quick 9", and "full 18" interpretation
* Supabase course enrichment can improve yardage/slope confidence where populated

Recommended derived signals:

```text
long_course_fit
short_round_fit
quick_9_fit
full_18_fit
beginner_friendly
challenge_round
forgiving_layout
```

## Tee-Time Availability Data

Primary utilities/types:

```text
src/types/TeeTimes.ts
src/utils/teeTimes.ts
```

Current exposed signals:

```text
next_available_tee_time
has_times_today
has_times_tomorrow
slots_next_3_days
has_morning_slots
has_afternoon_slots
has_evening_slots
has_weekend_slots
tee_times_last_updated_at
is_stale
```

Current freshness rule:

```text
28 hours
```

Current usefulness:

* good for "has fresh tee-time availability" where data exists
* can support weekend availability and day-part claims if fresh
* not enough alone to claim quietness or fast rounds

Recommended derived signals:

```text
availability_confidence
requested_date_available
fourball_availability_signal
weekend_capacity_proxy
pace_proxy_input
```

## Existing AI / Freeform Ranking Utilities

Relevant files:

```text
src/utils/aiCaddyRanking.ts
src/utils/freeformSearchEngine.ts
src/utils/searchIntentClient.ts
src/utils/aiSearchIntentCore.js
src/types/SearchIntent.ts
```

Current useful capabilities:

* freeform intent handling exists
* deterministic ranking already considers distance, value, playability, quality, condition and availability
* ranking already has reasons/breakdowns in places
* tee-time freshness is already respected
* course length scoring exists through playability/enrichment

Recommended use:

* reuse concepts and helper functions where robust
* do not expose existing AI assistant UI
* create a Round Agent-specific ranking contract with stricter reason codes, persistence and claims rules

---

# 4. Signal Readiness Matrix

| Signal | Current Source | Current Status | R1 Recommendation |
|---|---|---|---|
| `club_id` / identity | Supabase clubs, transformed club groups | Ready | Use canonical Supabase ID where available |
| `club_name` | Club data | Ready | Required |
| `county/location` | `Location (County)` | Ready | Required |
| `postcode` | Club data | Ready | Use for display/geography |
| `lat/lon` | Club data | Ready | Use for distance/access |
| `visitor_price` | `Pay & Play`, pricing utilities | Ready | Normalise min/max |
| `value_fit` | price + quality/condition proxies | Partial | Define explicit R1 value formula |
| `booking_route_confidence` | booking URL/provider utilities | Partial | Add as minor confidence/attribution signal |
| `availability_confidence` | tee-time summaries | Partial | Use only when fresh |
| `requested_date_available` | tee-time detail/day availability RPCs | Partial | Claim only with fresh supporting data |
| `conditions_fit` | live conditions | Ready | Enforce freshness |
| `wet_weather_fit` | drainage bucket + condition profile | Partial | Derive and store |
| `course_length_fit` | playability + yardage | Ready | Normalise into decision signal |
| `difficulty_fit` | playability + slope | Ready/partial | Use playability; slope where available |
| `quality_fit` | `top100London`, quality score, course enrichment | Partial | Needs safer definition |
| `access_corridor` | lat/lon/county + origin model | Missing | Build deterministic geography layer |
| `cross_city_penalty` | none | Missing | Build origin/corridor logic |
| `fourball_fit` | tee-time spots + course setup proxies | Missing/partial | Derive from availability/capacity signals |
| `weekend_capacity_proxy` | tee-time summaries + course setup | Missing/partial | Define carefully; no quietness claims |
| `pace_of_play_proxy` | none direct | Missing | Use safe proxy only |
| `weekend_crowding_risk` | none direct | Missing | Avoid strong claims in R1 |
| `worth_the_drive` | quality/value/access | Missing | Derive after value/quality definitions |
| `data_confidence` | scattered freshness/completeness | Missing | Add Supabase data-quality layer |

---

# 5. Browse Context Readiness

Browse already has rich context that Round Agent can use before the user types.

Available or likely available from current Browse state:

```text
selected counties
price min/max
distance radius
difficulty filters
length filters
condition filters
booking type filters
has tee-times filter
weekend availability filter
course format filter
sort mode
current result set
existing permitted user coordinates
distanceKm attached to club cards
```

Recommended Round Agent context object:

```json
{
  "source_surface": "browse",
  "current_filters": {},
  "sort_mode": "best_match",
  "location_context": {},
  "visible_result_ids": [],
  "temporal_context": {
    "today": "2026-08-25",
    "next_weekend": ["2026-08-29", "2026-08-30"]
  }
}
```

This is a strong starting point and should make the Browse-only beta feel more intelligent than a blank chatbot.

---

# 6. Location Intelligence Gap

Current data supports:

```text
straight-line distance
county filtering
postcode display
lat/lon geography
some drive-time functionality elsewhere
```

Current data does not support:

```text
South West London access preference
London sub-region inference
cross-city penalty
road-access corridors
route friction
county corridor preference
```

This is critical.

Example failure to avoid:

```text
User in South West London asks for a longer course near London.
Agent recommends The Shire because it is near London.
```

Expected behaviour:

```text
Agent favours Surrey/Berkshire/south-west-accessible options unless the user explicitly asks for North London.
```

Recommended R1 geography solution:

```text
1. Define key origin zones, starting with London sub-regions.
2. Map clubs to access corridors using county + bearing + lat/lon.
3. Apply cross-city penalties for poor practical routes.
4. Store derived access signals in Supabase.
```

Initial corridor examples:

```text
south_west_london
west_london
south_london
north_london
east_london
central_london
surrey_corridor
berkshire_corridor
kent_corridor
essex_corridor
hertfordshire_corridor
```

---

# 7. Group / Weekend / Pace Gap

The user query:

```text
I am looking for a longer course near London for a group of 4, ideally it's not a busy course on weekends and the rounds don't take forever.
```

requires signals Clublyst does not currently have directly.

## What Can Be Safely Derived Now

```text
longer course
18 holes
moderate/hard difficulty
location/access
booking route exists
fresh tee-time slots, where available
weekend slots, where available
```

## What Needs New Decision Signals

```text
fourball_fit
weekend_capacity_proxy
pace_of_play_proxy
weekend_crowding_risk
group_suitability
```

## Safe User-Facing Language

Use:

```text
better weekend capacity proxy
stronger four-ball fit
pace is not confirmed
availability confidence is medium
```

Avoid:

```text
quiet at weekends
fast rounds guaranteed
rounds don't take forever
always good for groups
```

unless Clublyst has direct supporting data.

---

# 8. Value / Quality Gap

Current useful proxies:

```text
Pay & Play price
relative local price in aiCaddyRanking
computeQualityScore
top100London
course metadata completeness
conditions
playability
```

Current issue:

There is not yet a single product-approved definition of:

```text
strong value
premium round
worth the drive
better course
quality relative to price
```

R1 should define these before visible launch.

Recommended approach:

```text
value_fit = relative price + condition/playability + quality proxy + data confidence
premium_round_fit = quality proxy + price tolerance + course fit
worth_the_drive = quality/value uplift minus access friction
```

All value/quality labels should be stored as structured signals with evidence and confidence.

---

# 9. Data Quality Gap

Current freshness/completeness signals are scattered across:

```text
conditions updated_at
tee_times_last_updated_at
course_enrichment enrichment_flagged
presence/absence of fields
```

Round Agent needs a single per-club data-quality view.

Recommended table:

```text
round_agent_data_quality
```

Minimum fields:

```text
has_price_data
has_value_signal
has_conditions_data
has_difficulty_data
has_booking_data
has_location_data
has_tee_time_data
condition_freshness
tee_time_freshness
price_freshness
overall_data_confidence
missing_decision_fields
stale_decision_fields
```

This should directly affect recommendation confidence and explanation restraint.

---

# 10. Proposed R1 Data Work

## Workstream A: Normalise Existing Signals

Create a single Round Agent-ready view/model that exposes:

```text
club_id
club_name
county
postcode
latitude
longitude
price_min
price_max
booking_provider
booking_route_confidence
condition_label
condition_score
condition_updated_at
drainage_bucket
holes
length_band
difficulty
yardage
slope_rating
tee_time_summary
top100London
```

## Workstream B: Generate Decision Signals

Populate:

```text
club_decision_signals
club_agent_enrichment
round_agent_data_quality
```

Initial high-priority signals:

```text
access_corridors
cross_city_penalty_origins
long_course_fit
fourball_fit
weekend_capacity_proxy
pace_of_play_proxy
wet_weather_fit
value_fit
worth_the_drive
data_confidence
```

## Workstream C: Build Ranking Harness

Before UI, create a harness that outputs:

```text
prompt
context
interpreted_intent
top ranked clubs
match percentage
confidence
reason codes
trade-off codes
decision metadata
```

This should be tested against the canonical prompts in:

```text
docs/round-agent-data-readiness-ranking-plan.md
```

---

# 11. Readiness By Signal

## Ready For R1

```text
price
county/location
lat/lon
booking route
conditions
course length/difficulty
tee-time freshness logic
Browse context
```

## Needs Derived Logic

```text
value fit
wet-weather fit
quality relative to price
access corridor
cross-city penalty
worth-the-drive
data confidence
```

## Needs AI-Led / Heuristic Enrichment

```text
fourball fit
weekend capacity proxy
pace-of-play proxy
group suitability
visitor/casual suitability beyond booking route
premium vs budget round fit
```

## Too Risky To Claim Directly In R1

```text
quiet weekends
guaranteed fast rounds
exact pace of play
member/visitor congestion
course atmosphere
green speed/quality
staff friendliness
```

These can only appear as cautious proxy-based trade-offs unless new reliable data is added.

---

# 12. Recommendation

Do not build the visible Browse Round Agent until the following are complete:

```text
1. Decision-signal schema agreed.
2. Access-corridor model agreed.
3. Value/quality definitions agreed.
4. Weekend/group/pace proxy rules agreed.
5. Data-quality confidence model agreed.
6. Ranking harness produces sensible output for canonical prompts.
```

The current data can support a useful agent, but the compelling version depends on the new AI-led decision layer.

The next best engineering step is:

```text
Design the Round Agent Supabase decision-signal schema and enrichment rules.
```
