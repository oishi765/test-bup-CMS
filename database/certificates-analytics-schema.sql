-- BUP Conference Management System
-- Certificates, Notification Preferences, and Analytics Schema Migration

-- 1. Extend public.certificates with revocation and metadata columns
alter table public.certificates
  add column if not exists is_revoked boolean not null default false,
  add column if not exists revoked_at timestamptz,
  add column if not exists revocation_reason text,
  add column if not exists revoked_by uuid references public.users(id),
  add column if not exists metadata jsonb default '{}'::jsonb;

create index if not exists idx_certificates_conference_type on public.certificates(conference_id, certificate_type);
create index if not exists idx_certificates_number on public.certificates(certificate_number);

-- 2. Certificate Templates
create table if not exists public.certificate_templates (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null references public.conferences(id) on delete cascade,
  certificate_type text not null check (certificate_type in ('attendee','author','presenter','reviewer','organizer')),
  title text not null,
  subtitle text,
  body_text text not null,
  signatory_name text not null default 'Conference General Chair',
  signatory_title text not null default 'Bangladesh University of Professionals',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(conference_id, certificate_type)
);

-- 3. Notification Preferences
create table if not exists public.notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  email_notifications boolean not null default true,
  submission_updates boolean not null default true,
  review_updates boolean not null default true,
  schedule_updates boolean not null default true,
  payment_updates boolean not null default true,
  certificate_updates boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 4. Extend public.notifications
alter table public.notifications
  add column if not exists category text default 'general',
  add column if not exists email_delivery_status text default 'not_applicable',
  add column if not exists metadata jsonb default '{}'::jsonb;

create index if not exists idx_notifications_user_unread on public.notifications(user_id, read_at);
