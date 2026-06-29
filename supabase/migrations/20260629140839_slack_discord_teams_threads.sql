-- Groundwork for Slack/Discord/Teams.
--
-- Append the new channels to the service enum with ADD VALUE rather than the
-- db-diff rename/recast: the recast cannot run because RLS policies (e.g.
-- "members can update contacts addresses") reference the service column, and
-- Postgres refuses to alter the type of a policy-referenced column. ADD VALUE
-- appends in place, touching neither the columns nor the policies.
alter type public.service add value if not exists 'slack';
alter type public.service add value if not exists 'discord';
alter type public.service add value if not exists 'teams';

-- Threads as a logical partition of a conversation (Slack/Discord-style): holds
-- the thread root's external_id; null = top-level. Soft reference, not a FK.
alter table public.messages add column thread_id text;
