-- RefundWaapsi v2.3: multi-agent staff workspace
-- Run after schema.sql / previous migrations.
alter table if exists users
  add column if not exists role varchar(20) not null default 'customer';

alter table if exists cases
  add column if not exists assigned_to uuid references users(id) on delete set null;

alter table if exists cases
  add column if not exists assigned_at timestamptz;

create index if not exists idx_cases_assigned_to on cases(assigned_to);
create index if not exists idx_users_role on users(role);
