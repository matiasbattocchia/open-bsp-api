alter table "public"."agents" enable row level security;

create policy "org members can read their org agents" on "public"."agents" for select to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"() )));

create policy "org admins can create agents in their orgs" on "public"."agents" for insert to "authenticated" with check (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "org admins can delete their org agents" on "public"."agents" for delete to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "org admins can update their org agents" on "public"."agents" for update to "authenticated" using (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") ))) with check (("organization_id" in ( select "public"."get_authorized_orgs"('admin'::"text") )));

create policy "users can update their extra field except roles" on "public"."agents" for update to "authenticated" using ((("organization_id" in ( select "public"."get_authorized_orgs"() )) and ("user_id" = "auth"."uid"()))) with check ((("organization_id" in ( select "public"."get_authorized_orgs"() )) and ("user_id" = "auth"."uid"()) and (("extra" -> 'roles'::"text") is null))); 