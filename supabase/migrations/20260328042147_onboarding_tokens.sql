
  create table "public"."onboarding_tokens" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "created_by" uuid not null,
    "created_at" timestamp with time zone not null default now(),
    "expires_at" timestamp with time zone not null,
    "used_at" timestamp with time zone,
    "status" text not null default 'active'::text
      );


alter table "public"."onboarding_tokens" enable row level security;

CREATE UNIQUE INDEX onboarding_tokens_pkey ON public.onboarding_tokens USING btree (id);

alter table "public"."onboarding_tokens" add constraint "onboarding_tokens_pkey" PRIMARY KEY using index "onboarding_tokens_pkey";

alter table "public"."onboarding_tokens" add constraint "onboarding_tokens_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) not valid;

alter table "public"."onboarding_tokens" validate constraint "onboarding_tokens_created_by_fkey";

alter table "public"."onboarding_tokens" add constraint "onboarding_tokens_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."onboarding_tokens" validate constraint "onboarding_tokens_organization_id_fkey";

alter table "public"."onboarding_tokens" add constraint "onboarding_tokens_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'used'::text, 'expired'::text]))) not valid;

alter table "public"."onboarding_tokens" validate constraint "onboarding_tokens_status_check";

grant delete on table "public"."onboarding_tokens" to "anon";

grant insert on table "public"."onboarding_tokens" to "anon";

grant references on table "public"."onboarding_tokens" to "anon";

grant select on table "public"."onboarding_tokens" to "anon";

grant trigger on table "public"."onboarding_tokens" to "anon";

grant truncate on table "public"."onboarding_tokens" to "anon";

grant update on table "public"."onboarding_tokens" to "anon";

grant delete on table "public"."onboarding_tokens" to "authenticated";

grant insert on table "public"."onboarding_tokens" to "authenticated";

grant references on table "public"."onboarding_tokens" to "authenticated";

grant select on table "public"."onboarding_tokens" to "authenticated";

grant trigger on table "public"."onboarding_tokens" to "authenticated";

grant truncate on table "public"."onboarding_tokens" to "authenticated";

grant update on table "public"."onboarding_tokens" to "authenticated";

grant delete on table "public"."onboarding_tokens" to "service_role";

grant insert on table "public"."onboarding_tokens" to "service_role";

grant references on table "public"."onboarding_tokens" to "service_role";

grant select on table "public"."onboarding_tokens" to "service_role";

grant trigger on table "public"."onboarding_tokens" to "service_role";

grant truncate on table "public"."onboarding_tokens" to "service_role";

grant update on table "public"."onboarding_tokens" to "service_role";


  create policy "owners can create onboarding tokens"
  on "public"."onboarding_tokens"
  as permissive
  for insert
  to authenticated
with check ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can delete onboarding tokens"
  on "public"."onboarding_tokens"
  as permissive
  for delete
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



  create policy "owners can read their org onboarding tokens"
  on "public"."onboarding_tokens"
  as permissive
  for select
  to authenticated
using ((organization_id IN ( SELECT public.get_authorized_orgs('owner'::public.role) AS get_authorized_orgs)));



