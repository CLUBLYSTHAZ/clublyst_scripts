# Round Agent Ranking Harness

**Script:** `scripts/round-agent/ranking-harness.mjs`  
**Workflow:** `.github/workflows/round-agent-ranking-harness.yml`

---

# Purpose

The ranking harness tests whether the Round Agent data layer can produce sensible recommendations before any Browse UI is built.

It runs:

```text
prompt + browse context
→ interpreted intent
→ deterministic ranking
→ match, confidence, reason codes, trade-off codes
```

The harness does not call an LLM. It is intentionally deterministic so recommendation quality can be inspected.

---

# How To Run In GitHub

1. Open GitHub.
2. Go to the repo.
3. Click **Actions**.
4. Select **Round Agent Ranking Harness**.
5. Click **Run workflow**.

For the first run:

```text
canonical = true
limit = 8
```

After it finishes, download the artifact:

```text
round-agent-ranking-harness-report
```

---

# Custom Prompt Example

Set:

```text
canonical = false
prompt = I am looking for a longer course near london for a group of 4, ideally its not a busy course on weekends and the rounds dont take forever
origin_context = south_west_london
limit = 8
```

---

# What Good Looks Like

For the South West London four-ball prompt, the ranking should:

```text
prefer south-west-accessible routes
prefer Surrey/Berkshire/south-west corridors
prefer longer/full 18 courses
avoid over-ranking North London purely because it is "near London"
include pace/weekend/fourball caveats
include travel friction, booking ease, weather/condition and round-duration signals where available
```

Expected trade-off codes:

```text
availability_stale_or_low_confidence
weekend_capacity_not_confirmed, when no weekend availability signal exists
pace_not_confirmed, when no pace proxy signal exists
fourball_fit_proxy_only, when no four-ball signal exists
```

Those are good signs when the supporting data is absent or stale. They mean the system is being honest about what it cannot directly know yet.

---

# What Bad Looks Like

Flag the harness output if:

```text
North/east London dominates a South West London request
short courses rank highly for "longer course"
hard constraints are violated
recommendations have no reason codes
trade-offs are missing for pace/weekend claims
low-data-confidence clubs rank without caution
```

---

# Current Limitations

The harness currently uses deterministic signals already in Supabase:

```text
access_fit
access_corridor
travel_friction_fit
long_course_fit
full_18_fit
beginner_friendly
difficulty_fit
wet_weather_fit
weather_impact_fit
condition_freshness
value_fit
booking_route_confidence
booking_ease_score
availability_confidence
weekend_availability_fit
fourball_fit
pace_of_play_proxy
round_duration_risk
round_agent_data_quality
```

The following remain proxy-led and should be explained carefully:

```text
fourball_fit
weekend_availability_fit
pace_of_play_proxy
round_duration_risk
travel_friction_fit
```

Do not claim exact quietness, exact journey time or exact round duration unless direct supporting evidence exists. For beta, phrase these as fit/risk signals.
