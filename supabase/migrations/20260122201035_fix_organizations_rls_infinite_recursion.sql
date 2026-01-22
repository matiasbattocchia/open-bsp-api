drop policy "admins can update their orgs, without changing their name" on "public"."organizations";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.org_update_by_admin_rules(p_id uuid, p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return exists (
    select 1 from public.organizations
    where id = p_id
      -- name cannot be changed by admins
      and name = p_name
  );
end;
$function$
;


  create policy "admins can update their orgs, without changing their name"
  on "public"."organizations"
  as permissive
  for update
  to authenticated, anon
using ((id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)))
with check (((id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)) AND public.org_update_by_admin_rules(id, name)));



