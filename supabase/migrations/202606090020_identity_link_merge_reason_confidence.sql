-- Migration 020: persist identity merge strategy metadata.
-- Adds merge_reason and confidence_level to identity_links with safe backfill.

alter table if exists public.identity_links
  add column if not exists merge_reason text,
  add column if not exists confidence_level text;

update public.identity_links
set merge_reason = case
  when merge_reason is not null then merge_reason
  when upper(coalesce(linked_reason, '')) in ('PHONE_MATCH', 'NAME_ADDRESS_MATCH', 'FINGERPRINT_MATCH', 'PHONE_CHANGE_CONTINUITY') then upper(linked_reason)
  else 'PHONE_MATCH'
end
where merge_reason is null;

update public.identity_links
set confidence_level = case
  when confidence_score >= 90 then 'HIGH'
  when confidence_score >= 70 then 'MEDIUM'
  else 'LOW'
end
where confidence_level is null;

alter table if exists public.identity_links
  drop constraint if exists identity_links_merge_reason_check;

alter table if exists public.identity_links
  add constraint identity_links_merge_reason_check
  check (merge_reason in ('PHONE_MATCH', 'NAME_ADDRESS_MATCH', 'FINGERPRINT_MATCH', 'PHONE_CHANGE_CONTINUITY'));

alter table if exists public.identity_links
  drop constraint if exists identity_links_confidence_level_check;

alter table if exists public.identity_links
  add constraint identity_links_confidence_level_check
  check (confidence_level in ('HIGH', 'MEDIUM', 'LOW'));
