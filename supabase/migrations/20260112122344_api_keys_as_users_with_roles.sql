create type "public"."role" as enum ('owner', 'admin', 'member');

drop trigger if exists "lookup_org_address" on "public"."logs";

drop policy "admins can create their orgs api keys" on "public"."api_keys";

drop policy "admins can delete their orgs api keys" on "public"."api_keys";

drop policy "admins can read their orgs api keys" on "public"."api_keys";

drop policy "anonymous can manage conversations with valid api key" on "public"."conversations";

drop policy "anonymous can create messages with valid api key" on "public"."messages";

drop policy "anonymous can read messages with valid api key" on "public"."messages";

drop policy "anonymous can read addresses with valid api key" on "public"."organizations_addresses";

drop policy "admins can manage their orgs ai agents" on "public"."agents";

drop policy "members can read their orgs agents" on "public"."agents";

drop policy "owners can create their orgs ai agents and send invitations" on "public"."agents";

drop policy "owners can delete their orgs agents" on "public"."agents";

drop policy "owners can update their orgs agents" on "public"."agents";

drop policy "members can manage their orgs contacts" on "public"."contacts";

drop policy "members can manage their orgs conversations" on "public"."conversations";

drop policy "members can create their orgs messages" on "public"."messages";

drop policy "members can read their orgs messages" on "public"."messages";

drop policy "admins can update their orgs, without changing their name" on "public"."organizations";

drop policy "members can read their orgs" on "public"."organizations";

drop policy "owners can delete their orgs" on "public"."organizations";

drop policy "members can read their orgs addresses" on "public"."organizations_addresses";

drop policy "admins can manage their orgs quick replies" on "public"."quick_replies";

drop policy "members can read their orgs quick replies" on "public"."quick_replies";

drop policy "admins can manage their orgs webhooks" on "public"."webhooks";

drop policy "members can download their orgs media" on "storage"."objects";

drop policy "members can upload their orgs media" on "storage"."objects";

alter table "public"."logs" drop constraint "logs_organization_id_organization_address_fkey";

drop function if exists "public"."before_insert_on_logs"();

drop function if exists "public"."get_authorized_org_by_api_key"();

drop function if exists "public"."get_authorized_orgs"(role text);

drop index if exists "public"."idx_logs_address";

drop index if exists "public"."idx_logs_org_id";

alter table "public"."api_keys" add column "role" public.role not null default 'member'::public.role;

alter table "public"."contacts" alter column "name" drop not null;

CREATE INDEX idx_logs_organization_id_address ON public.logs USING btree (organization_id, organization_address);

alter table "public"."logs" add constraint "logs_organization_address_fkey" FOREIGN KEY (organization_id, organization_address) REFERENCES public.organizations_addresses(organization_id, address) ON DELETE CASCADE not valid;

alter table "public"."logs" validate constraint "logs_organization_address_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_authorized_orgs(role public.role DEFAULT 'member'::public.role)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req_level int;
  api_key text;
  org_id uuid;
begin
  req_level := case role::text
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  -- First, try JWT authentication via auth.uid()
  if auth.uid() is not null then
    return query select organization_id from public.agents
    where
      user_id = auth.uid()
    and (
      extra->'invitation' is null
      or extra->'invitation'->>'status' = 'accepted'
    )
    and (
      case (extra->>'role')
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if found then
      return;
    end if;

    raise exception using
      errcode = '42501',
      message = format('insufficient permissions, %s role required', role::text);
  end if;

  -- Fallback to API key authentication
  api_key := current_setting('request.headers', true)::json->>'api-key';
  
  if api_key is not null then
    select a.organization_id into org_id
    from public.api_keys a
    where a.key = api_key
    and (
      case (a.role::text)
        when 'owner' then 3
        when 'admin' then 2
        else 1 -- 'member'
      end
    ) >= req_level;

    if org_id is not null then
      return next org_id;
      return;
    end if;

    raise exception using
      errcode = '42501',
      message = format('invalid api key or insufficient permissions, %s role required', role::text);
  end if;

  raise exception using
    errcode = '42501',
    message = 'authentication required',
    hint = 'use api-key header or jwt authentication';
end;
$function$
;


  create policy "owners can create their orgs api keys"
  on "public"."api_keys"
  as permissive
  for insert
  to authenticated, anon
with check ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can delete their orgs api keys"
  on "public"."api_keys"
  as permissive
  for delete
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can read their orgs api keys"
  on "public"."api_keys"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "admins can manage their orgs ai agents"
  on "public"."agents"
  as permissive
  for all
  to authenticated, anon
using (((organization_id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)) AND (user_id IS NULL) AND (ai = true)));



  create policy "members can read their orgs agents"
  on "public"."agents"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "owners can create their orgs ai agents and send invitations"
  on "public"."agents"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)) AND ((ai = true) OR ((ai = false) AND (((extra -> 'invitation'::text) ->> 'status'::text) = 'pending'::text) AND (((extra -> 'invitation'::text) ->> 'email'::text) IS NOT NULL)))));



  create policy "owners can delete their orgs agents"
  on "public"."agents"
  as permissive
  for delete
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can update their orgs agents"
  on "public"."agents"
  as permissive
  for update
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)))
with check (public.agent_update_by_owner_rules(id, user_id, organization_id, ai, extra));



  create policy "members can manage their orgs contacts"
  on "public"."contacts"
  as permissive
  for all
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "members can manage their orgs conversations"
  on "public"."conversations"
  as permissive
  for all
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "members can create their orgs messages"
  on "public"."messages"
  as permissive
  for insert
  to authenticated, anon
with check ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "members can read their orgs messages"
  on "public"."messages"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "admins can update their orgs, without changing their name"
  on "public"."organizations"
  as permissive
  for update
  to authenticated, anon
using ((id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)))
with check (((id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)) AND (name = ( SELECT o.name
   FROM public.organizations o
  WHERE (o.id = o.id)))));



  create policy "members can read their orgs"
  on "public"."organizations"
  as permissive
  for select
  to authenticated, anon
using ((id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "owners can delete their orgs"
  on "public"."organizations"
  as permissive
  for delete
  to authenticated, anon
using ((id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "members can read their orgs addresses"
  on "public"."organizations_addresses"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "admins can manage their orgs quick replies"
  on "public"."quick_replies"
  as permissive
  for all
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)));



  create policy "members can read their orgs quick replies"
  on "public"."quick_replies"
  as permissive
  for select
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::public.role) AS get_authorized_orgs)));



  create policy "admins can manage their orgs webhooks"
  on "public"."webhooks"
  as permissive
  for all
  to authenticated, anon
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)));


  create policy "members can download their orgs media"
  on "storage"."objects"
  as permissive
  for select
  to authenticated, anon
using (((bucket_id = 'media'::text) AND ((storage.foldername(name))[2] IN ( SELECT (public.get_authorized_orgs('member'::public.role))::text AS get_authorized_orgs))));



  create policy "members can upload their orgs media"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated, anon
with check (((bucket_id = 'media'::text) AND ((storage.foldername(name))[2] IN ( SELECT (public.get_authorized_orgs('member'::public.role))::text AS get_authorized_orgs))));



