alter table "public"."organizations" enable row level security;

create policy "org members can read their orgs" on "public"."organizations" for select to "authenticated" using (("id" in ( select "public"."get_authorized_orgs"() )));

create policy "org members can update their orgs" on "public"."organizations" for update to "authenticated" using (("id" in ( select "public"."get_authorized_orgs"('admin'::"text") ))); 