alter table "public"."organizations" add column "domain" text;

alter table "public"."organizations" add constraint "organizations_domain_check" CHECK ((domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'::text)) not valid;

alter table "public"."organizations" validate constraint "organizations_domain_check";

