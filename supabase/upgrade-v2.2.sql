-- RefundWaapsi v2.2: link paid human-support conversations to their original AI lead chat.
alter table if exists cases
  add column if not exists lead_id uuid references leads(id) on delete set null;

create index if not exists idx_cases_lead_id on cases(lead_id);
