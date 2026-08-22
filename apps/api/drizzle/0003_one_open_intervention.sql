-- At most ONE open intervention per case.
--
-- Two provider events arriving milliseconds apart both dispatched the strategy
-- agent (dispatching does not move the case, so the second look saw the same
-- unchanged state). Both proposed, both passed the policy gate, and the
-- customer received the same email twice ten seconds apart. The contact budget
-- did not catch it: two emails is under the 3-per-14-days cap, and the 24h
-- spacing rule governs payment retries, not messages.
--
-- This is the same class of guarantee as the caseId:interventionId:attempt
-- idempotency key: enforced by the database, so no dispatch site can forget it.
CREATE UNIQUE INDEX IF NOT EXISTS "interventions_one_open_per_case"
  ON "interventions" ("case_id")
  WHERE "status" IN ('proposed', 'pending_approval', 'approved', 'executing');
