-- Partial indexes on contacts_addresses.extra for the BSUID model
-- (all gated to the whatsapp service):
--   phone_number      — phone-based search (address != extra.phone_number ~half the time)
--   bsuid             — user_id_update handler matches on extra.bsuid
--   replaced_by_bsuid — link a new address back to the old contact after a BSUID change

create index contacts_addresses_phone_number_idx
on public.contacts_addresses
using btree ((extra ->> 'phone_number'))
where service = 'whatsapp';

create index contacts_addresses_bsuid_idx
on public.contacts_addresses
using btree ((extra ->> 'bsuid'))
where service = 'whatsapp';

create index contacts_addresses_replaced_by_bsuid_idx
on public.contacts_addresses
using btree ((extra ->> 'replaced_by_bsuid'))
where service = 'whatsapp';
