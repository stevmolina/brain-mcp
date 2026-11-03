-- Hosted starter brains and billing.
--
-- pages is the canonical markdown for a kind='hosted' brain, which has no git
-- repo. Claims stay derived: drop them and reindex the pages, lose nothing.
--
-- accounts and billing_events are subscription state from Polar. They are not
-- brain content. They cannot live in the customer's markdown, because the
-- customer could then change their own plan. GitHub is still the only
-- permission list for kind='github' brains.

alter table brains alter column owner_github_login drop not null;

alter table brains add column kind text not null default 'github';

alter table brains add constraint brains_kind_check check (kind in ('github', 'hosted'));

create table pages (
  brain_id   text not null references brains (id) on delete cascade,
  path       text not null,
  content    text not null,
  updated_at timestamptz not null default now(),
  primary key (brain_id, path)
);

create table accounts (
  workos_user_id            text primary key,
  email                     text not null,
  plan                      text not null default 'free' check (plan in ('free', 'team')),
  polar_customer_id         text,
  polar_subscription_id     text,
  polar_subscription_status text,
  current_period_end        timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- webhook-id, so a Polar retry does not apply the same event twice.
create table billing_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);
