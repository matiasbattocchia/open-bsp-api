-- Extend webhook_table enum to support conversation_labels events
alter type public.webhook_table add value if not exists 'conversation_labels';

-- Extend webhook_operation enum to support delete events
alter type public.webhook_operation add value if not exists 'delete';

-- Labels: reusable tags defined per organization.
-- The label name acts as its identifier within the organization scope.
create table public.labels (
  name            text                     not null,
  organization_id uuid                     not null,
  color           text,
  created_at      timestamp with time zone not null default now()
);

alter table only public.labels
add constraint labels_pkey
primary key (name, organization_id);

alter table only public.labels
add constraint labels_organization_id_fkey
foreign key (organization_id)
references public.organizations(id)
on delete cascade
not valid;

create index labels_organization_idx
on public.labels
using btree (organization_id);

alter table public.labels enable row level security;

-- Conversation labels: N:N join between conversations and labels.
create table public.conversation_labels (
  conversation_id uuid                     not null,
  label_name      text                     not null,
  organization_id uuid                     not null,
  applied_at      timestamp with time zone not null default now(),
  applied_by      uuid
);

alter table only public.conversation_labels
add constraint conversation_labels_pkey
primary key (conversation_id, label_name, organization_id);

alter table only public.conversation_labels
add constraint conversation_labels_conversation_id_fkey
foreign key (conversation_id)
references public.conversations(id)
on delete cascade
not valid;

alter table only public.conversation_labels
add constraint conversation_labels_label_fkey
foreign key (label_name, organization_id)
references public.labels(name, organization_id)
on delete cascade
not valid;

create index conversation_labels_conversation_idx
on public.conversation_labels
using btree (conversation_id);

create index conversation_labels_organization_idx
on public.conversation_labels
using btree (organization_id);

alter table public.conversation_labels enable row level security;

-- RLS: labels (definitions managed by admins, readable by members)
create policy "members can read their orgs labels"
on public.labels
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "admins can manage their orgs labels"
on public.labels
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('admin')
  )
);

-- RLS: conversation_labels (applied by members during conversations)
create policy "members can read their orgs conversation labels"
on public.conversation_labels
for select
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

create policy "members can manage their orgs conversation labels"
on public.conversation_labels
for all
to authenticated, anon
using (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
)
with check (
  organization_id in (
    select public.get_authorized_orgs('member')
  )
);

-- Webhook dispatcher for conversation_labels.
-- Extends the existing notify_webhook pattern to support DELETE events,
-- using OLD record when the operation is a removal.
create function public.notify_labels_webhook() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_record record;
  headers        jsonb;
  record_data    jsonb;
begin
  record_data := case tg_op
    when 'DELETE' then to_jsonb(old)
    else to_jsonb(new)
  end;

  for webhook_record in
    select w.url, w.token
    from public.webhooks w
    where (record_data->>'organization_id')::uuid = w.organization_id
      and w.table_name = 'conversation_labels'::public.webhook_table
      and lower(tg_op)::public.webhook_operation = any(w.operations)
    limit 3
  loop
    headers := case
      when webhook_record.token is not null then
        jsonb_build_object(
          'content-type', 'application/json',
          'authorization', 'Bearer ' || webhook_record.token
        )
      else
        jsonb_build_object('content-type', 'application/json')
    end;

    perform net.http_post(
      url    := webhook_record.url,
      body   := jsonb_build_object(
        'data',   record_data,
        'entity', tg_table_name,
        'action', lower(tg_op)
      ),
      headers := headers
    );
  end loop;

  return coalesce(new, old);
end;
$$;

create trigger notify_webhook_conversation_labels
after insert or delete
on public.conversation_labels
for each row
execute function public.notify_labels_webhook();
