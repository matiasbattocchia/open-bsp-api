alter table "public"."api_keys" enable row level security;

create policy "org members can read their org api keys" on "public"."api_keys" for select to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() )));

create policy "org admins can create api keys in their orgs" on "public"."api_keys" for insert to "authenticated" with check (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "org admins can delete their org api keys" on "public"."api_keys" for delete to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") ))); 