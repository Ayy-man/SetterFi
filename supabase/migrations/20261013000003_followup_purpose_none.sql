-- A follow-up touch a coach has switched off.
--
-- "Nothing" is a seventh purpose rather than a delete: the platform still owns the schedule and
-- its count, and the coach's row on offer_cadence_purposes keeps meaning "what this touch is for".
-- materializeCadence drops a position resolving to it, so nothing is queued and no template is
-- looked up. Its own file because ALTER TYPE ... ADD VALUE cannot share a transaction with a use.
alter type public.followup_purpose add value if not exists 'none';
