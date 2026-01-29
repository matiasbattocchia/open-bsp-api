drop policy "owners can create their orgs ai agents and send invitations" on "public"."agents";


  create policy "admins can create their orgs ai agents"
  on "public"."agents"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('admin'::public.role) AS get_authorized_orgs)) AND (ai = true)));



  create policy "owners can send invitations"
  on "public"."agents"
  as permissive
  for insert
  to authenticated, anon
with check (((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)) AND (ai = false) AND (((extra -> 'invitation'::text) ->> 'status'::text) = 'pending'::text) AND (((extra -> 'invitation'::text) ->> 'email'::text) IS NOT NULL)));



