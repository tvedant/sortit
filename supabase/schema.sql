-- RefundWaapsi production schema
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  email varchar(320) not null unique,
  password_hash text not null,
  role varchar(20) not null default 'customer',
  created_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name varchar(120), contact varchar(160), story text, category varchar(40), summary text,
  stage integer not null default 0,
  user_id uuid references users(id) on delete set null,
  status varchar(20) not null default 'in-progress',
  source varchar(20) not null default 'scripted',
  transcript jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  case_id varchar(20) not null unique,
  user_id uuid not null references users(id) on delete cascade,
  user_email varchar(320) not null,
  user_name varchar(120) not null,
  category varchar(40), description text, summary text,
  amount_paise integer not null,
  payment_status varchar(20) not null default 'pending',
  razorpay_order_id varchar(100), razorpay_payment_id varchar(100),
  status varchar(30) not null default 'awaiting_payment',
  lead_id uuid references leads(id) on delete set null,
  assigned_to uuid references users(id) on delete set null,
  assigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists case_files (
  id uuid primary key default gen_random_uuid(),
  case_id varchar(20) not null references cases(case_id) on delete cascade,
  filename text not null,
  original_name text not null,
  storage_path text not null unique,
  mime_type varchar(120) not null,
  size integer not null,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  case_id varchar(20) not null references cases(case_id) on delete cascade,
  sender varchar(20) not null,
  sender_name varchar(120) not null,
  text varchar(2000) not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_user_id on leads(user_id);
create index if not exists idx_leads_created_at on leads(created_at desc);
create index if not exists idx_cases_user_id on cases(user_id);
create index if not exists idx_cases_payment_status on cases(payment_status);
create index if not exists idx_cases_assigned_to on cases(assigned_to);
create index if not exists idx_users_role on users(role);
create index if not exists idx_messages_case_id_created_at on messages(case_id, created_at);
create index if not exists idx_case_files_case_id on case_files(case_id);

-- The application talks to Supabase only from the trusted Node backend.
-- Keep tables protected from browser roles; the server-only secret/secret key
-- bypasses RLS. If you later expose tables directly to a browser, add explicit
-- least-privilege RLS policies first.
alter table public.users enable row level security;
alter table public.leads enable row level security;
alter table public.cases enable row level security;
alter table public.case_files enable row level security;
alter table public.messages enable row level security;

-- Keep this bucket private. The server creates short-lived signed URLs only
-- after checking that the requesting customer owns the case or is an admin.
insert into storage.buckets (id, name, public)
values ('case-proofs', 'case-proofs', false)
on conflict (id) do update set public = false;
