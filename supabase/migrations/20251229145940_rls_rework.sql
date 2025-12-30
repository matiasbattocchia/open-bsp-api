drop policy "org admins can create agents in their orgs" on "public"."agents";

drop policy "org admins can delete their org agents" on "public"."agents";

drop policy "org admins can update their org agents" on "public"."agents";

drop policy "org members can read their org agents" on "public"."agents";

drop policy "users can update their extra field except roles" on "public"."agents";

drop policy "org admins can create api keys in their orgs" on "public"."api_keys";

drop policy "org admins can delete their org api keys" on "public"."api_keys";

drop policy "org members can read their org api keys" on "public"."api_keys";

drop policy "org members can create their orgs contacts" on "public"."contacts";

drop policy "org members can read their orgs contacts" on "public"."contacts";

drop policy "org members can update their orgs contacts" on "public"."contacts";

drop policy "org members can read their orgs contacts addresses" on "public"."contacts_addresses";

drop policy "org members can manage their orgs conversations" on "public"."conversations";

drop policy "org members can create their orgs messages" on "public"."messages";

drop policy "org members can read their orgs messages" on "public"."messages";

drop policy "org members can read their orgs" on "public"."organizations";

drop policy "org members can update their orgs" on "public"."organizations";

drop policy "org members can read their orgs addresses" on "public"."organizations_addresses";

drop policy "org members can manage their org quick replies" on "public"."quick_replies";

drop policy "org admins can create webhooks in their orgs" on "public"."webhooks";

drop policy "org admins can delete their org webhooks" on "public"."webhooks";

drop policy "org admins can update their org webhooks" on "public"."webhooks";

drop policy "org members can read their org webhooks" on "public"."webhooks";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_authorized_orgs(role text DEFAULT 'member'::text)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  req_level int;
begin
  req_level := case role
    when 'owner' then 3
    when 'admin' then 2
    else 1 -- 'member'
  end;

  return query select organization_id from public.agents where user_id = auth.uid()
  and (
    case (extra->>'role')
      when 'owner' then 3
      when 'admin' then 2
      else 1 -- 'member'
    end
  ) >= req_level;
end;
$function$
;


  create policy "admins can manage their orgs ai agents"
  on "public"."agents"
  as permissive
  for all
  to authenticated
using (((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)) AND (user_id IS NULL) AND (ai = true)));



  create policy "members can delete themselves"
  on "public"."agents"
  as permissive
  for delete
  to authenticated
using ((user_id = auth.uid()));



  create policy "members can read their orgs agents"
  on "public"."agents"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "members can update themselves, without changing their org nor r"
  on "public"."agents"
  as permissive
  for update
  to authenticated
using ((user_id = auth.uid()))
with check (((user_id = auth.uid()) AND (organization_id = ( SELECT a.organization_id
   FROM public.agents a
  WHERE (a.id = a.id))) AND ((extra ->> 'role'::text) = ( SELECT (a.extra ->> 'role'::text)
   FROM public.agents a
  WHERE (a.id = a.id)))));



  create policy "owners can manage their orgs agents"
  on "public"."agents"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)));



  create policy "admins can create their orgs api keys"
  on "public"."api_keys"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "admins can delete their orgs api keys"
  on "public"."api_keys"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "admins can read their orgs api keys"
  on "public"."api_keys"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "members can manage their orgs contacts"
  on "public"."contacts"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "members can read their orgs contacts addresses"
  on "public"."contacts_addresses"
  as permissive
  for select
  to authenticated
using ((contact_id IN ( SELECT contacts.id
   FROM public.contacts
  WHERE (contacts.organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)))));



  create policy "members can manage their orgs conversations"
  on "public"."conversations"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "members can create their orgs messages"
  on "public"."messages"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "members can read their orgs messages"
  on "public"."messages"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "admins can update their orgs, without changing their name"
  on "public"."organizations"
  as permissive
  for update
  to authenticated
using ((id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)))
with check (((id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)) AND (name = ( SELECT o.name
   FROM public.organizations o
  WHERE (o.id = o.id)))));



  create policy "members can read their orgs"
  on "public"."organizations"
  as permissive
  for select
  to authenticated
using ((id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "owners can delete their orgs"
  on "public"."organizations"
  as permissive
  for delete
  to authenticated
using ((id IN ( SELECT public.get_authorized_orgs('owner'::text) AS get_authorized_orgs)));



  create policy "users can create orgs"
  on "public"."organizations"
  as permissive
  for insert
  to authenticated
with check (true);



  create policy "members can read their orgs addresses"
  on "public"."organizations_addresses"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "admins can manage their orgs quick replies"
  on "public"."quick_replies"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)));



  create policy "members can read their orgs quick replies"
  on "public"."quick_replies"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('member'::text) AS get_authorized_orgs)));



  create policy "admins can manage their orgs webhooks"
  on "public"."webhooks"
  as permissive
  for all
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('admin'::text) AS get_authorized_orgs)));


drop policy "org members can manage their orgs media" on "storage"."objects";


  create policy "members can download their orgs media"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
using (((bucket_id = 'media'::text) AND ((storage.foldername(name))[2] IN ( SELECT (public.get_authorized_orgs('member'::text))::text AS get_authorized_orgs))));



  create policy "members can upload their orgs media"
  on "storage"."objects"
  as permissive
  for insert
  to authenticated
with check (((bucket_id = 'media'::text) AND ((storage.foldername(name))[2] IN ( SELECT (public.get_authorized_orgs('member'::text))::text AS get_authorized_orgs))));

drop function if exists "public"."get_authorized_orgs"();