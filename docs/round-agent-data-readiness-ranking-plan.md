# Clublyst Round Agent

## Data Readiness & Ranking Plan

**Status:** Planning  
**Surface for first beta:** Browse/results only  
**Goal:** Make Round Agent a genuinely useful golf decision engine, not a generic chatbot.

---

# 1. Core Product Standard

Round Agent should feel like it understands the real decision a golfer is trying to make.

It must not simply translate natural language into existing filters and return a bland list.

The feature is successful when it can answer:

> Given this golfer's context, constraints and trade-offs, which course is the most sensible round to book?

The agent should be:

* grounded in Clublyst data
* sensitive to access and travel reality
* honest about uncertainty
* concise and easy to follow
* inspectable through Supabase
* deterministic in ranking
* premium in presentation

---

# 2. Immediate Build Sequence

Do not start with UI.

Recommended sequence:

```text
1. Define canonical golfer prompts
2. Define required decision signals
3. Build/prepare Supabase signal schema
4. Enrich clubs with structured decision signals
5. Build ranking test harness
6. Validate recommendations manually
7. Build Browse-only Round Agent UI
8. Launch behind feature flag
```

The Browse UI should be built only once the recommendation output is good enough to be trusted.

---

# 3. Canonical Test Prompts

Create a fixed set of real golfer prompts before implementation.

These prompts become acceptance fixtures for intent parsing, ranking and explanation quality.

## Prompt 1: South West London Four-Ball

```text
I am looking for a longer course near London for a group of 4, ideally it's not a busy course on weekends and the rounds don't take forever.
```

Expected interpretation:

* user likely means practical access from their context, not all London courses
* if origin is South West London, favour Surrey/Berkshire/south-west corridors
* longer 18-hole course preferred
* party size = 4
* weekend suitability matters
* pace/crowding are preferences, not guaranteed facts

Required data:

* origin/access context
* access corridor
* course length
* group/four-ball fit
* weekend capacity proxy
* pace-of-play proxy
* availability confidence
* data confidence

Agent should avoid:

* recommending North London solely because it is "near London"
* claiming a course is quiet at weekends unless directly supported
* guaranteeing round duration

## Prompt 2: Wet-Weather Value Round

```text
Somewhere near me under £50 that will still be decent if it rains.
```

Required data:

* user location or clarification
* price
* conditions
* wet-weather fit
* drainage/playability signal
* value signal

## Prompt 3: Beginner-Friendly Visitor Round

```text
I want an easy course for a newer golfer, ideally not too expensive.
```

Required data:

* difficulty
* length
* beginner-friendly signal
* visitor suitability
* price/value

## Prompt 4: Best Quality Within A Drive

```text
I don't mind driving 45 minutes if the course is properly worth it.
```

Required data:

* origin
* drive-time/distance
* quality/value fit
* worth-the-drive signal
* price/value trade-off

## Prompt 5: Quick Round

```text
I only have time for a quick round after work.
```

Required data:

* current day/time
* 9-hole/short course fit
* daylight/time-of-day context
* distance
* booking/availability confidence

## Prompt 6: Group Weekend Round

```text
Four of us want to play this Saturday morning, not somewhere impossible to get on.
```

Required data:

* party size
* requested date/time
* availability confidence
* weekend capacity proxy
* group fit

## Prompt 7: Conditions First

```text
Conditions matter more than price. Find me the best playable course nearby.
```

Required data:

* conditions freshness
* condition score/label
* wet-weather/current playability
* distance
* confidence

## Prompt 8: Strict Budget

```text
Must be under £35 and close to Croydon.
```

Required data:

* hard budget constraint
* location
* price
* distance

Agent should avoid:

* returning courses above budget as matches

## Prompt 9: Flexible Premium

```text
Looking for a really good course around Surrey, budget isn't a big issue.
```

Required data:

* county/location
* course quality signal
* value still present but lower weight
* difficulty/conditions

## Prompt 10: Missing Location

```text
Somewhere nice this weekend.
```

Expected behaviour:

* if no location context exists, ask one clarification:

```text
Where should I search from?
```

---

# 4. Context Inferred Before The User Types

On Browse, Round Agent should start with context from the current page.

Use where available:

```text
current filters
current URL/search params
current sort mode
existing permitted location
visible result set
recent in-session club views
saved clubs
booking clicks
map/list interaction
device type
current date/time
data freshness/confidence
```

Example context object:

```json
{
  "source_surface": "browse",
  "current_filters": {
    "locations": ["Surrey"],
    "visitor_max_price": 50,
    "conditions": ["good", "great"],
    "difficulty": ["easy", "moderate"]
  },
  "sort_mode": "best_match",
  "location_context": {
    "available": true,
    "source": "existing_permission",
    "label": "South West London"
  },
  "visible_result_ids": ["club_1", "club_2", "club_3"],
  "session_signals": {
    "viewed_club_ids": [],
    "saved_club_ids": [],
    "likely_priority": ["value", "conditions"]
  },
  "temporal_context": {
    "today": "2026-08-25",
    "day_of_week": "Tuesday",
    "next_weekend": ["2026-08-29", "2026-08-30"]
  }
}
```

Round Agent should feel like it has read the room.

---

# 5. Location Intelligence

Location must go beyond simple radius.

The agent should understand practical access.

## Required Concepts

```text
origin_point
origin_label
london_sub_region
access_corridor
cross_city_penalty
county_corridor
drive_time_or_distance
route_friction
```

For example:

```text
South West London
```

should usually favour:

```text
Surrey
Berkshire
south/west London
selected Hampshire or West Sussex routes
```

and penalise:

```text
North London
Essex
Hertfordshire
east Kent
routes requiring cross-London travel
```

unless the user explicitly asks for those areas.

## Requirement

Round Agent should not treat all courses "near London" as equally sensible.

It should account for origin, direction and travel friction.

---

# 6. Decision Signals Needed Across Clubs

The current Clublyst data should be enriched into Round Agent decision signals.

## Geography & Access

```text
access_corridors
london_access_zone
cross_city_penalty_origins
route_friction
distance_from_key_origins
```

## Course Fit

```text
long_course_fit
short_round_fit
quick_9_fit
full_18_fit
beginner_friendly
challenge_round
forgiving_layout
```

## Group & Weekend Fit

```text
fourball_fit
society_group_fit
weekend_capacity_proxy
pace_of_play_proxy
weekend_crowding_risk
availability_confidence
```

## Conditions & Playability

```text
wet_weather_fit
good_drainage
winter_playability
condition_freshness
condition_confidence
```

## Value & Quality

```text
value_fit
premium_round_fit
worth_the_drive
quality_relative_to_price
budget_round_fit
```

## Booking

Because Clublyst clubs have direct booking links, booking existence should not be a major differentiator.

Use booking data for:

```text
booking_route_confidence
booking_page_type
booking_provider
availability_confidence
```

Do not over-rank a club simply because it has a direct booking route; that is expected Clublyst behaviour.

---

# 7. Supabase Data Layer

Round Agent should use and extend the AI-led data layer defined in:

```text
docs/round-agent-ai-data-layer-requirements.md
```

Minimum required tables:

```text
club_decision_signals
club_agent_enrichment
round_agent_data_quality
```

Minimum signal metadata:

```text
club_id
signal_key
signal_value
confidence
evidence
source_type
generated_at
review_status
```

Decision-time recommendations should also persist:

```text
session_id
query_id
club_id
result_position
match_percentage
recommendation_confidence
reason_codes
tradeoff_codes
decision_metadata
```

---

# 8. Ranking Model

The ranking engine should be deterministic.

The LLM may interpret intent, but it must not choose the winning course.

## Base Signals

```text
budget_fit
value_fit
distance_fit
access_fit
availability_fit
condition_fit
difficulty_fit
course_length_fit
group_fit
pace_proxy_fit
course_quality_fit
data_confidence
```

## Dynamic Weighting

Explicit user language should adjust ranking.

Examples:

```text
"longer course"
→ increase course_length_fit
```

```text
"group of 4"
→ increase group_fit and availability_fit
```

```text
"not busy on weekends"
→ increase weekend_capacity_proxy and pace_proxy_fit
```

```text
"near London" + known South West London context
→ increase access_fit for Surrey/Berkshire corridors
```

```text
"must be under £50"
→ budget becomes a hard constraint
```

## Missing Data

Missing optional data should:

* reduce confidence where relevant
* prevent unsupported claims
* affect ranking only where necessary to satisfy the user's request

---

# 9. Reason Codes & Trade-Off Codes

Ranking must output structured reasons.

## Example Reason Codes

```text
within_budget
strong_value
close_to_origin
good_access_corridor
long_course_fit
fourball_fit
weekend_capacity_proxy_positive
pace_proxy_positive
good_conditions
wet_weather_fit
moderate_difficulty
worth_the_drive
requested_date_available
availability_confidence_medium
```

## Example Trade-Off Codes

```text
availability_not_confirmed
pace_not_confirmed
longer_drive
cross_city_penalty
above_preferred_budget
conditions_stale
weaker_value
harder_than_requested
limited_group_signal
```

The user-facing explanation should be built from these codes and trusted data.

---

# 10. Claims Policy

Round Agent must be careful with claims that are hard to know.

## Do Not Claim Unless Supported

```text
quiet at weekends
fast rounds guaranteed
rounds under 4 hours
always good for groups
tee times available
excellent drainage
friendly atmosphere
premium condition
```

## Prefer Safe Language

```text
better weekend capacity proxy
stronger four-ball fit
pace is not confirmed
availability confidence is medium
good fit based on course length and access
better south-west London access
conditions data is fresh
```

---

# 11. Test Harness Requirement

Before UI work, create a way to test:

```text
prompt
context
interpreted_intent
candidate clubs
ranking output
reason codes
trade-off codes
confidence
final user-facing summary
```

The harness should run against canonical prompts and show the top recommendations.

Output should be reviewable by a human before launch.

Acceptance standard:

* recommendations make real-world sense
* location/access logic is sensible
* reasons are grounded
* unsupported claims are absent
* confidence reflects data quality
* hard constraints are respected

---

# 12. Browse-Only Beta UX Implication

First public beta should launch only on Browse/results.

Round Agent should appear above results and produce its own recommendation output.

Existing Browse results must not be reordered.

The experience should feel like:

```text
premium recommendation module
```

not:

```text
chatbot thread
```

Minimum output:

```text
Best Pick
Up to three alternatives
Match percentage
Recommendation confidence
Decision facts
Why this
Trade-off
Book now
View details
```

---

# 13. Readiness Checklist

Round Agent is not ready for UI build until:

```text
[ ] Canonical prompts are agreed.
[ ] Required decision signals are defined.
[ ] Supabase decision-signal schema is agreed.
[ ] Club enrichment process is designed.
[ ] Location/access corridor logic is designed.
[ ] Ranking inputs and dynamic weights are designed.
[ ] Reason/trade-off code taxonomy is agreed.
[ ] Claims policy is agreed.
[ ] Freshness thresholds are agreed.
[ ] Test harness output can be reviewed.
[ ] South West London example ranks sensible Surrey/Berkshire options above North London.
```

---

# 14. Success Standard

Round Agent should not feel useful because it says more words.

It should feel useful because it makes a better decision.

The first beta should prove:

> Clublyst can combine user context, access reality, decision signals and current course data to recommend a round a golfer would actually book.
