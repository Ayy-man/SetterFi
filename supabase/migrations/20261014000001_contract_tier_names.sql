-- Names only: preserve every price, allowance, provider identifier and subscription reference.
-- These three seeded rows hold the intake's contract ladder; the other demo tiers remain labelled.
update public.tiers as tier
set name = names.name
from (values
  ('86000000-0000-4000-8000-000000000001'::uuid, 'Starter (demo)', 'Starter'),
  ('86000000-0000-4000-8000-000000000002'::uuid, 'Growth (demo)', 'Growth'),
  ('86000000-0000-4000-8000-000000000003'::uuid, 'Scale (demo)', 'Scale')
) as names(id, old_name, name)
where tier.id = names.id and tier.name = names.old_name;
