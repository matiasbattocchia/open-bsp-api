drop policy "anonymous can manage messages with valid api key" on "public"."messages";

drop policy "org members can manage their orgs messages" on "public"."messages";

create policy "anonymous can create messages with valid api key"
on "public"."messages"
as permissive
for insert
to anon
with check ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id = ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)))));


create policy "anonymous can read messages with valid api key"
on "public"."messages"
as permissive
for select
to anon
using ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id = ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)))));


create policy "org members can create their orgs messages"
on "public"."messages"
as permissive
for insert
to authenticated
with check ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)))));


create policy "org members can read their orgs messages"
on "public"."messages"
as permissive
for select
to authenticated
using ((organization_address IN ( SELECT organizations_addresses.address
   FROM organizations_addresses
  WHERE (organizations_addresses.organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)))));


create policy "anonymous can read addresses with valid api key"
on "public"."organizations_addresses"
as permissive
for select
to anon
using ((organization_id = ( SELECT get_authorized_org_by_api_key() AS get_authorized_org_by_api_key)));



