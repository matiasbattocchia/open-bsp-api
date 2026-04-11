
  create policy "owners can update their orgs"
  on "public"."organizations"
  as permissive
  for update
  to authenticated, anon
using ((id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)))
with check ((id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



