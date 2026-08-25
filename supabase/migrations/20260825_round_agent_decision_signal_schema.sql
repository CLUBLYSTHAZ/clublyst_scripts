-- Round Agent decision-signal schema
-- Purpose: Store AI-led and deterministic per-club decision intelligence for
--          Round Agent without changing the core Clublyst product tables.

create extension if not exists pgcrypto;

create table if not exists public.club_decision_signals (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,

  -- Examples: long_course_fit, wet_weather_fit, access_corridor,
  -- fourball_fit, pace_of_play_proxy, value_fit.
  signal_key text not null check (char_length(signal_key) between 1 and 120),

  -- Allows multiple contextual versions of the same signal, e.g.
  -- signal_key='access_fit', signal_context='south_west_london'.
  signal_context text not null default 'global'
    check (char_length(signal_context) between 1 and 120),

  -- Human-readable categorical value: high, medium, low, positive, negative,
  -- south_west_london, strong, weak, etc.
  signal_value text not null check (char_length(signal_value) between 1 and 160),

  -- Optional numeric ranking input. Keep generic so signals can choose their
  -- own scale, but recommend 0-100 for new Round Agent signals.
  signal_score numeric(6,2),

  confidence text not null default 'medium'
    check (confidence in ('high', 'medium', 'low')),

  evidence jsonb not null default '{}'::jsonb,
  signal_payload jsonb not null default '{}'::jsonb,

  source_type text not null default 'derived'
    check (
      source_type in (
        'derived',
        'ai_enriched',
        'manual',
        'clublyst_structured_data',
        'conditions',
        'tee_times',
        'booking',
        'pricing',
        'course_enrichment'
      )
    ),
  source_version text,
  source_updated_at timestamptz,

  generated_by text not null default 'round_agent',
  generated_at timestamptz not null default now(),

  review_status text not null default 'auto_approved'
    check (review_status in ('auto_approved', 'needs_review', 'approved', 'rejected', 'retired')),
  reviewed_at timestamptz,
  review_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (club_id, signal_key, signal_context)
);

create index if not exists club_decision_signals_club_id_idx
  on public.club_decision_signals (club_id);

create index if not exists club_decision_signals_key_context_idx
  on public.club_decision_signals (signal_key, signal_context);

create index if not exists club_decision_signals_confidence_idx
  on public.club_decision_signals (confidence);

create index if not exists club_decision_signals_review_status_idx
  on public.club_decision_signals (review_status);

create index if not exists club_decision_signals_evidence_gin_idx
  on public.club_decision_signals using gin (evidence);

create index if not exists club_decision_signals_payload_gin_idx
  on public.club_decision_signals using gin (signal_payload);

create table if not exists public.club_agent_enrichment (
  club_id uuid primary key references public.clubs(id) on delete cascade,

  -- Agent-ready denormalised tags for fast candidate reads.
  round_fit_tags text[] not null default '{}'::text[],
  decision_strengths text[] not null default '{}'::text[],
  tradeoff_flags text[] not null default '{}'::text[],
  access_corridors text[] not null default '{}'::text[],

  best_for text[] not null default '{}'::text[],
  avoid_if text[] not null default '{}'::text[],

  agent_summary text,
  summary_confidence text not null default 'medium'
    check (summary_confidence in ('high', 'medium', 'low')),

  data_confidence text not null default 'medium'
    check (data_confidence in ('high', 'medium', 'low')),

  needs_review boolean not null default false,
  review_reason text,
  review_status text not null default 'auto_approved'
    check (review_status in ('auto_approved', 'needs_review', 'approved', 'rejected', 'retired')),

  source_version text,
  generated_by text not null default 'round_agent',
  generated_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists club_agent_enrichment_round_fit_tags_gin_idx
  on public.club_agent_enrichment using gin (round_fit_tags);

create index if not exists club_agent_enrichment_decision_strengths_gin_idx
  on public.club_agent_enrichment using gin (decision_strengths);

create index if not exists club_agent_enrichment_tradeoff_flags_gin_idx
  on public.club_agent_enrichment using gin (tradeoff_flags);

create index if not exists club_agent_enrichment_access_corridors_gin_idx
  on public.club_agent_enrichment using gin (access_corridors);

create index if not exists club_agent_enrichment_confidence_idx
  on public.club_agent_enrichment (data_confidence, summary_confidence);

create index if not exists club_agent_enrichment_review_status_idx
  on public.club_agent_enrichment (review_status);

create table if not exists public.round_agent_data_quality (
  club_id uuid primary key references public.clubs(id) on delete cascade,

  has_price_data boolean not null default false,
  has_value_signal boolean not null default false,
  has_conditions_data boolean not null default false,
  has_difficulty_data boolean not null default false,
  has_booking_data boolean not null default false,
  has_location_data boolean not null default false,
  has_tee_time_data boolean not null default false,
  has_access_signal boolean not null default false,
  has_group_signal boolean not null default false,
  has_pace_signal boolean not null default false,

  condition_freshness text
    check (condition_freshness is null or condition_freshness in ('fresh', 'stale', 'unknown')),
  tee_time_freshness text
    check (tee_time_freshness is null or tee_time_freshness in ('fresh', 'stale', 'unknown')),
  price_freshness text
    check (price_freshness is null or price_freshness in ('fresh', 'stale', 'unknown')),
  booking_freshness text
    check (booking_freshness is null or booking_freshness in ('fresh', 'stale', 'unknown')),

  overall_data_confidence text not null default 'medium'
    check (overall_data_confidence in ('high', 'medium', 'low')),

  missing_decision_fields text[] not null default '{}'::text[],
  stale_decision_fields text[] not null default '{}'::text[],
  quality_notes jsonb not null default '{}'::jsonb,

  generated_by text not null default 'round_agent',
  generated_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists round_agent_data_quality_confidence_idx
  on public.round_agent_data_quality (overall_data_confidence);

create index if not exists round_agent_data_quality_missing_fields_gin_idx
  on public.round_agent_data_quality using gin (missing_decision_fields);

create index if not exists round_agent_data_quality_stale_fields_gin_idx
  on public.round_agent_data_quality using gin (stale_decision_fields);

-- Updated-at trigger support. Some projects already define public.set_updated_at.
create or replace function public.set_round_agent_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_club_decision_signals_updated_at on public.club_decision_signals;
create trigger trg_club_decision_signals_updated_at
before update on public.club_decision_signals
for each row execute function public.set_round_agent_updated_at();

drop trigger if exists trg_club_agent_enrichment_updated_at on public.club_agent_enrichment;
create trigger trg_club_agent_enrichment_updated_at
before update on public.club_agent_enrichment
for each row execute function public.set_round_agent_updated_at();

drop trigger if exists trg_round_agent_data_quality_updated_at on public.round_agent_data_quality;
create trigger trg_round_agent_data_quality_updated_at
before update on public.round_agent_data_quality
for each row execute function public.set_round_agent_updated_at();

alter table public.club_decision_signals enable row level security;
alter table public.club_agent_enrichment enable row level security;
alter table public.round_agent_data_quality enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'club_decision_signals'
      and policyname = 'public can read approved club decision signals'
  ) then
    create policy "public can read approved club decision signals"
      on public.club_decision_signals
      for select
      to anon, authenticated
      using (review_status in ('auto_approved', 'approved'));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'club_agent_enrichment'
      and policyname = 'public can read approved club agent enrichment'
  ) then
    create policy "public can read approved club agent enrichment"
      on public.club_agent_enrichment
      for select
      to anon, authenticated
      using (review_status in ('auto_approved', 'approved'));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'round_agent_data_quality'
      and policyname = 'public can read round agent data quality'
  ) then
    create policy "public can read round agent data quality"
      on public.round_agent_data_quality
      for select
      to anon, authenticated
      using (true);
  end if;
end
$$;
