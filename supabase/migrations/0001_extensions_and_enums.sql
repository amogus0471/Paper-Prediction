-- Ghostfill 0001 — extensions and enums.
-- Forward-only. Never edit a committed migration.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

do $$ begin
  create type venue_code     as enum ('polymarket','kalshi');
exception when duplicate_object then null; end $$;

do $$ begin
  create type market_status  as enum ('open','closed','resolving','resolved','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_side     as enum ('buy','sell');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outcome_side   as enum ('yes','no');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_type     as enum ('market','limit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status   as enum ('pending','open','partial','filled','cancelled','rejected','expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type txn_kind       as enum ('grant','fill_debit','fill_credit','fee','settlement','reset','adjustment');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sim_realism    as enum ('instant','realistic','brutal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type division_tier  as enum ('bronze','silver','gold','platinum','diamond');
exception when duplicate_object then null; end $$;

do $$ begin
  create type integrity_kind as enum ('multi_account','wash_trade','stale_quote','rate_abuse','impossible_latency','book_impact','resolution_frontrun');
exception when duplicate_object then null; end $$;
