-- Remove the change_contact_address RPC. BSUID changes are now handled by the
-- user_id_update webhook (marking the old contact address inactive with a
-- replaced_by_bsuid trail); phone-number-change re-keying is no longer done.
drop function if exists "public"."change_contact_address"(
  p_organization_id uuid, old_address text, new_address text
);
