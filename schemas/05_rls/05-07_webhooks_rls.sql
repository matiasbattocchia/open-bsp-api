alter table "public"."webhooks" enable row level security;

create policy "org members can read their org webhooks" on "public"."webhooks" for select to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() )));

create policy "org admins can create webhooks in their orgs" on "public"."webhooks" for insert to "authenticated" with check (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "org admins can delete their org webhooks" on "public"."webhooks" for delete to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "org admins can update their org webhooks" on "public"."webhooks" for update to "authenticated" with check (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") ))); 