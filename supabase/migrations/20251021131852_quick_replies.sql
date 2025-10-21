create table "public"."quick_replies" (
    "id" uuid not null default gen_random_uuid(),
    "organization_id" uuid not null,
    "name" text not null,
    "content" text not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."quick_replies" enable row level security;

CREATE INDEX quick_replies_organization_idx ON public.quick_replies USING btree (organization_id);

CREATE UNIQUE INDEX quick_replies_pkey ON public.quick_replies USING btree (id);

alter table "public"."quick_replies" add constraint "quick_replies_pkey" PRIMARY KEY using index "quick_replies_pkey";

alter table "public"."quick_replies" add constraint "quick_replies_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE not valid;

alter table "public"."quick_replies" validate constraint "quick_replies_organization_id_fkey";

grant delete on table "public"."quick_replies" to "anon";

grant insert on table "public"."quick_replies" to "anon";

grant references on table "public"."quick_replies" to "anon";

grant select on table "public"."quick_replies" to "anon";

grant trigger on table "public"."quick_replies" to "anon";

grant truncate on table "public"."quick_replies" to "anon";

grant update on table "public"."quick_replies" to "anon";

grant delete on table "public"."quick_replies" to "authenticated";

grant insert on table "public"."quick_replies" to "authenticated";

grant references on table "public"."quick_replies" to "authenticated";

grant select on table "public"."quick_replies" to "authenticated";

grant trigger on table "public"."quick_replies" to "authenticated";

grant truncate on table "public"."quick_replies" to "authenticated";

grant update on table "public"."quick_replies" to "authenticated";

grant delete on table "public"."quick_replies" to "service_role";

grant insert on table "public"."quick_replies" to "service_role";

grant references on table "public"."quick_replies" to "service_role";

grant select on table "public"."quick_replies" to "service_role";

grant trigger on table "public"."quick_replies" to "service_role";

grant truncate on table "public"."quick_replies" to "service_role";

grant update on table "public"."quick_replies" to "service_role";

create policy "org members can manage their org quick replies"
on "public"."quick_replies"
as permissive
for all
to authenticated
using ((organization_id IN ( SELECT get_authorized_orgs() AS get_authorized_orgs)));


CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.quick_replies FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');


