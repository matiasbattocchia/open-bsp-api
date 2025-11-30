create type "public"."log_level" as enum ('info', 'warning', 'error');


  create table "public"."logs" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "organization_address" text,
    "level" public.log_level not null,
    "category" text not null,
    "message" text not null,
    "metadata" jsonb,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."logs" enable row level security;

CREATE INDEX idx_logs_address ON public.logs USING btree (organization_address);

CREATE INDEX idx_logs_created_at ON public.logs USING btree (created_at DESC);

CREATE INDEX idx_logs_org_id ON public.logs USING btree (organization_id);

CREATE UNIQUE INDEX logs_pkey ON public.logs USING btree (id);

alter table "public"."logs" add constraint "logs_pkey" PRIMARY KEY using index "logs_pkey";

alter table "public"."logs" add constraint "logs_organization_address_fkey" FOREIGN KEY (organization_address) REFERENCES public.organizations_addresses(address) ON DELETE CASCADE not valid;

alter table "public"."logs" validate constraint "logs_organization_address_fkey";

alter table "public"."logs" add constraint "logs_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE not valid;

alter table "public"."logs" validate constraint "logs_organization_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_log()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.organization_id is not null then
    return new;
  end if;

  select organization_id into new.organization_id
  from public.organizations_addresses
  where address = new.organization_address;

  return new;
end;
$function$
;

grant delete on table "public"."logs" to "anon";

grant insert on table "public"."logs" to "anon";

grant references on table "public"."logs" to "anon";

grant select on table "public"."logs" to "anon";

grant trigger on table "public"."logs" to "anon";

grant truncate on table "public"."logs" to "anon";

grant update on table "public"."logs" to "anon";

grant delete on table "public"."logs" to "authenticated";

grant insert on table "public"."logs" to "authenticated";

grant references on table "public"."logs" to "authenticated";

grant select on table "public"."logs" to "authenticated";

grant trigger on table "public"."logs" to "authenticated";

grant truncate on table "public"."logs" to "authenticated";

grant update on table "public"."logs" to "authenticated";

grant delete on table "public"."logs" to "service_role";

grant insert on table "public"."logs" to "service_role";

grant references on table "public"."logs" to "service_role";

grant select on table "public"."logs" to "service_role";

grant trigger on table "public"."logs" to "service_role";

grant truncate on table "public"."logs" to "service_role";

grant update on table "public"."logs" to "service_role";

CREATE TRIGGER create_log BEFORE INSERT ON public.logs FOR EACH ROW EXECUTE FUNCTION public.create_log();

