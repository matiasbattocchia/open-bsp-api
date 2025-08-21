alter table "public"."organizations_addresses" enable row level security;

create policy "org members can read their orgs addresses" on "public"."organizations_addresses" for select to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() ))); 