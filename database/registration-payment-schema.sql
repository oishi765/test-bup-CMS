-- Conference registration, tiers, payments, and refunds schema for Supabase Cloud PostgreSQL.
-- Run in the Supabase SQL Editor after peer-review-schema.sql.
begin;

-- Capacity field on conferences
alter table public.conferences add column if not exists max_capacity integer check (max_capacity is null or max_capacity > 0);

-- Configurable registration categories / tiers per conference
create table if not exists public.conference_registration_tiers (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null references public.conferences(id) on delete cascade,
  category text not null check (category in ('author','student','professional','general_attendee')),
  title text not null check (length(title) between 2 and 150),
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  currency char(3) not null default 'BDT' check (currency in ('BDT','USD','EUR','GBP')),
  eligibility_criteria text,
  deadline_at timestamptz,
  capacity integer check (capacity is null or capacity > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(conference_id, category)
);

-- Registration extensions
alter table public.registrations add column if not exists tier_id uuid references public.conference_registration_tiers(id) on delete set null;
alter table public.registrations add column if not exists reference_code text;
alter table public.registrations add column if not exists category text not null default 'general_attendee';
alter table public.registrations add column if not exists payment_status text not null default 'unpaid';
alter table public.registrations add column if not exists paper_id uuid references public.submissions(id) on delete set null;
alter table public.registrations add column if not exists organization text;
alter table public.registrations add column if not exists dietary_requirements text;
alter table public.registrations add column if not exists special_needs text;
alter table public.registrations add column if not exists cancellation_reason text;
alter table public.registrations add column if not exists cancellation_requested_at timestamptz;
alter table public.registrations add column if not exists cancelled_at timestamptz;

alter table public.registrations drop constraint if exists registrations_status_check;
alter table public.registrations add constraint registrations_status_check
  check (status in ('pending','confirmed','cancellation_requested','cancelled','refunded'));

alter table public.registrations drop constraint if exists registrations_category_check;
alter table public.registrations add constraint registrations_category_check
  check (category in ('author','student','professional','general_attendee','speaker','organizer','attendee'));

alter table public.registrations drop constraint if exists registrations_payment_status_check;
alter table public.registrations add constraint registrations_payment_status_check
  check (payment_status in ('unpaid','submitted','verified','rejected','refund_requested','refunded'));

create unique index if not exists registrations_reference_code_unique on public.registrations(reference_code) where reference_code is not null;
create index if not exists idx_registrations_conf_category on public.registrations(conference_id, category);
create index if not exists idx_registrations_conf_payment on public.registrations(conference_id, payment_status);

-- Payments extensions
alter table public.payments add column if not exists payment_method text not null default 'bank_transfer';
alter table public.payments add column if not exists transaction_reference text;
alter table public.payments add column if not exists receipt_object_key text;
alter table public.payments add column if not exists receipt_filename text;
alter table public.payments add column if not exists receipt_file_size integer check (receipt_file_size is null or receipt_file_size > 0);
alter table public.payments add column if not exists verified_at timestamptz;
alter table public.payments add column if not exists verified_by uuid references public.users(id) on delete set null;
alter table public.payments add column if not exists verification_notes text;
alter table public.payments add column if not exists rejection_reason text;

alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments add constraint payments_status_check
  check (status in ('pending','submitted','verified','succeeded','rejected','failed','refund_requested','refunded'));

alter table public.payments drop constraint if exists payments_payment_method_check;
alter table public.payments add constraint payments_payment_method_check
  check (payment_method in ('bank_transfer','mobile_banking','wire_transfer','cash','other'));

create index if not exists idx_payments_verification on public.payments(status, created_at desc);

-- Refunds table
create table if not exists public.registration_refunds (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.registrations(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'BDT' check (currency in ('BDT','USD','EUR','GBP')),
  reason text not null check (length(reason) between 5 and 2000),
  status text not null default 'requested' check (status in ('requested','approved','processed','rejected')),
  requested_by uuid not null references public.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  processed_by uuid references public.users(id) on delete set null,
  processed_at timestamptz,
  processor_reference text,
  admin_notes text
);
create index if not exists idx_refunds_registration on public.registration_refunds(registration_id);

-- Seed standard registration tiers for all existing conferences
insert into public.conference_registration_tiers(conference_id, category, title, description, amount, currency, eligibility_criteria)
select c.id, t.category, t.title, t.description, t.amount, 'BDT', t.eligibility
from public.conferences c
cross join (
  values
    ('author', 'Author Registration', 'Includes presentation slot, conference kit, and proceedings inclusion.', 5000.00, 'Requires accepted BUP paper code.'),
    ('student', 'Student Registration', 'Subsidized rate for current students. Valid student ID required.', 2000.00, 'Requires active student identification.'),
    ('professional', 'Professional / Industry Attendee', 'Full access for corporate, industry, and institutional attendees.', 6000.00, 'Open to all professionals and corporate delegates.'),
    ('general_attendee', 'General Attendee', 'General access to academic keynotes, tracks, and open sessions.', 3000.00, 'Open to general public and researchers.')
) as t(category, title, description, amount, eligibility)
on conflict(conference_id, category) do nothing;

commit;
