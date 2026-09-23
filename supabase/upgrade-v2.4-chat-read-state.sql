-- RefundWaapsi v14: per-viewer conversation read cursor
-- Run this once in Supabase SQL Editor.
-- This stores the last message timestamp each customer/agent/admin has actually viewed.

create table if not exists public.case_reads (
  viewer_id uuid not null references public.users(id) on delete cascade,
  case_id varchar(100) not null references public.cases(case_id) on delete cascade,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (viewer_id, case_id)
);

create index if not exists case_reads_viewer_idx
  on public.case_reads(viewer_id);

create index if not exists case_reads_case_idx
  on public.case_reads(case_id);

-- The application uses the Supabase service-role key server-side, so this table
-- does not need browser-facing RLS policies for the current architecture.

