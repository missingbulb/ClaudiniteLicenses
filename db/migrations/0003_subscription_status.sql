-- What Polar's subscription object carries that the paid-seat rule reads: a row pays while its
-- status is active, trialing or past_due and ended_at is null. ended_at stays null while the
-- subscription runs.

ALTER TABLE subscriptions ADD COLUMN status TEXT;
ALTER TABLE subscriptions ADD COLUMN ended_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN product_id TEXT;
ALTER TABLE subscriptions ADD COLUMN interval TEXT CHECK (interval IN ('month', 'year'));
