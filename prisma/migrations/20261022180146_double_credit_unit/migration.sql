-- AlterTable
ALTER TABLE "users" ALTER COLUMN "credits_balance" SET DEFAULT 4;

-- The unit itself is changing (a full generation now costs 2, a rescore
-- costs 1, instead of everything costing a flat 1) -- doubling every
-- existing balance preserves exactly the same real entitlement (what
-- used to buy N generations still buys N generations), it's just now
-- expressed in the finer unit. Safe for everyone regardless of plan or
-- balance: 0 stays 0, PREMIUM accounts don't use this column at all.
UPDATE "users" SET "credits_balance" = "credits_balance" * 2;
