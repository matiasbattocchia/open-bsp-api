alter table "public"."conversations" drop constraint "conversations_organization_address_fkey";

alter table "public"."conversations" alter column "contact_address" drop not null;

alter table "public"."conversations" alter column "organization_address" drop not null;

UPDATE "public"."messages"
SET agent_id = NULL
WHERE agent_id IS NOT NULL
  AND agent_id NOT IN (SELECT id FROM "public"."agents");

alter table "public"."messages" add constraint "messages_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL not valid;

alter table "public"."messages" validate constraint "messages_agent_id_fkey";

alter table "public"."conversations" add constraint "conversations_organization_address_fkey" FOREIGN KEY (organization_address) REFERENCES public.organizations_addresses(address) ON DELETE SET NULL not valid;

alter table "public"."conversations" validate constraint "conversations_organization_address_fkey";


