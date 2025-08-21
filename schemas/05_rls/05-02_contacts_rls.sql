alter table "public"."contacts" enable row level security;

create policy "org members can read their orgs contacts" on "public"."contacts" for select to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() )));

create policy "org members can create their orgs contacts" on "public"."contacts" for insert to "authenticated" with check (("organization_id" in ( select "public"."get_authorized_orgs"() )));

create policy "org members can update their orgs contacts" on "public"."contacts" for update to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() ))); 