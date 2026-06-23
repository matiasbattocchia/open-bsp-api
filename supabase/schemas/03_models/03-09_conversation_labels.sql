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

create trigger notify_webhook_conversation_labels
after insert or delete
on public.conversation_labels
for each row
execute function public.notify_labels_webhook();
