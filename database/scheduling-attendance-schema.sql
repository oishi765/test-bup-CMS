-- Conference scheduling, presentation slots, attendance, and QR check-in schema.
-- Apply after registration-payment-schema.sql in the Supabase SQL Editor.
begin;

-- Extend sessions table
alter table public.sessions add column if not exists session_code text;
alter table public.sessions add column if not exists room text;
alter table public.sessions add column if not exists format text not null default 'in_person';
alter table public.sessions add column if not exists session_chair_id uuid references public.users(id) on delete set null;
alter table public.sessions add column if not exists is_published boolean not null default false;
alter table public.sessions add column if not exists session_type text not null default 'paper_session';

alter table public.sessions drop constraint if exists sessions_format_check;
alter table public.sessions add constraint sessions_format_check
  check (format in ('in_person', 'virtual', 'hybrid'));

alter table public.sessions drop constraint if exists sessions_session_type_check;
alter table public.sessions add constraint sessions_session_type_check
  check (session_type in ('keynote', 'paper_session', 'poster_session', 'workshop', 'panel', 'break'));

create index if not exists idx_sessions_conf_published on public.sessions(conference_id, is_published, starts_at);
create index if not exists idx_sessions_chair on public.sessions(session_chair_id);
create index if not exists idx_sessions_room_time on public.sessions(conference_id, room, starts_at, ends_at);

-- Extend session_submissions (presentation slots)
alter table public.session_submissions add column if not exists id uuid default gen_random_uuid();
alter table public.session_submissions add column if not exists slot_number integer not null default 1;
alter table public.session_submissions add column if not exists starts_at timestamptz;
alter table public.session_submissions add column if not exists ends_at timestamptz;
alter table public.session_submissions add column if not exists duration_minutes integer not null default 15;
alter table public.session_submissions add column if not exists presenter_user_id uuid references public.users(id) on delete set null;
alter table public.session_submissions add column if not exists presentation_status text not null default 'scheduled';
alter table public.session_submissions add column if not exists chair_notes text;
alter table public.session_submissions add column if not exists updated_at timestamptz not null default now();

alter table public.session_submissions drop constraint if exists session_submissions_presentation_status_check;
alter table public.session_submissions add constraint session_submissions_presentation_status_check
  check (presentation_status in ('scheduled', 'in_progress', 'completed', 'absent', 'cancelled', 'rescheduled'));

alter table public.session_submissions drop constraint if exists session_submissions_duration_check;
alter table public.session_submissions add constraint session_submissions_duration_check
  check (duration_minutes > 0);

create index if not exists idx_session_submissions_presenter on public.session_submissions(presenter_user_id);
create index if not exists idx_session_submissions_status on public.session_submissions(presentation_status);

-- Extend attendance table
alter table public.attendance add column if not exists check_in_method text not null default 'manual';
alter table public.attendance add column if not exists attendance_role text not null default 'participant';

alter table public.attendance drop constraint if exists attendance_check_in_method_check;
alter table public.attendance add constraint attendance_check_in_method_check
  check (check_in_method in ('manual', 'qr_code', 'chair_verified'));

alter table public.attendance drop constraint if exists attendance_role_check;
alter table public.attendance add constraint attendance_role_check
  check (attendance_role in ('participant', 'presenter', 'chair', 'organizer'));

-- Secure rotating QR check-in tokens
create table if not exists public.session_checkin_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_checkin_tokens_session on public.session_checkin_tokens(session_id, expires_at);

commit;
