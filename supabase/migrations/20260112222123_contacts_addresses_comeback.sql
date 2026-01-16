
  create table "public"."contacts_addresses" (
    "organization_id" uuid not null,
    "service" public.service not null,
    "address" text not null,
    "extra" jsonb,
    "status" text not null default 'active'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."contacts_addresses" enable row level security;

CREATE UNIQUE INDEX contacts_addresses_pkey ON public.contacts_addresses USING btree (organization_id, address);

alter table "public"."contacts_addresses" add constraint "contacts_addresses_pkey" PRIMARY KEY using index "contacts_addresses_pkey";

alter table "public"."contacts_addresses" add constraint "contacts_addresses_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."contacts_addresses" validate constraint "contacts_addresses_organization_id_fkey";

-- Data migration: Insert missing contact addresses from existing conversations
-- This ensures the FK constraint won't fail on existing data
insert into "public"."contacts_addresses" (organization_id, service, address)
select distinct c.organization_id, c.service, c.contact_address
from "public"."conversations" c
where c.contact_address is not null
  and not exists (
    select 1 from "public"."contacts_addresses" ca
    where ca.organization_id = c.organization_id
      and ca.address = c.contact_address
  );

alter table "public"."conversations" add constraint "conversations_contact_address_fkey" FOREIGN KEY (organization_id, contact_address) REFERENCES public.contacts_addresses(organization_id, address) not valid;

alter table "public"."conversations" validate constraint "conversations_contact_address_fkey";

grant delete on table "public"."contacts_addresses" to "anon";

grant insert on table "public"."contacts_addresses" to "anon";

grant references on table "public"."contacts_addresses" to "anon";

grant select on table "public"."contacts_addresses" to "anon";

grant trigger on table "public"."contacts_addresses" to "anon";

grant truncate on table "public"."contacts_addresses" to "anon";

grant update on table "public"."contacts_addresses" to "anon";

grant delete on table "public"."contacts_addresses" to "authenticated";

grant insert on table "public"."contacts_addresses" to "authenticated";

grant references on table "public"."contacts_addresses" to "authenticated";

grant select on table "public"."contacts_addresses" to "authenticated";

grant trigger on table "public"."contacts_addresses" to "authenticated";

grant truncate on table "public"."contacts_addresses" to "authenticated";

grant update on table "public"."contacts_addresses" to "authenticated";

grant delete on table "public"."contacts_addresses" to "service_role";

grant insert on table "public"."contacts_addresses" to "service_role";

grant references on table "public"."contacts_addresses" to "service_role";

grant select on table "public"."contacts_addresses" to "service_role";

grant trigger on table "public"."contacts_addresses" to "service_role";

grant truncate on table "public"."contacts_addresses" to "service_role";

grant update on table "public"."contacts_addresses" to "service_role";


  create policy "members can read their orgs contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));


CREATE TRIGGER set_extra BEFORE UPDATE ON public.contacts_addresses FOR EACH ROW WHEN ((new.extra IS NOT NULL)) EXECUTE FUNCTION public.merge_update('extra');

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.contacts_addresses FOR EACH ROW EXECUTE FUNCTION public.moddatetime('updated_at');


