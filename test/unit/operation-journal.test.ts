import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FusionOperationJournal } from "../../src/operation-journal.js";

test("operation journal fences same identity across restart and rejects parameter drift", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new FusionOperationJournal(dir);
  assert.equal(first.claim("operation", "sha256:first"), "claimed");
  const restarted = new FusionOperationJournal(dir);
  assert.equal(restarted.claim("operation", "sha256:first"), "existing");
  assert.throws(() => restarted.claim("operation", "sha256:second"), /different request digest/);
  restarted.cancel("operation");
  assert.equal(first.claim("operation", "sha256:first"), "cancelled");
});

test("prelaunch cancellation is durable and prevents a late original launch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  new FusionOperationJournal(dir).cancel("late");
  assert.equal(new FusionOperationJournal(dir).claim("late", "sha256:late"), "cancelled");
});

test("confirmed prelaunch refusal releases its claim without removing a cancellation fence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new FusionOperationJournal(dir);
  assert.equal(journal.claim("retry", "digest"), "claimed");
  journal.releaseBeforeLaunch("retry");
  assert.equal(journal.claim("retry", "digest"), "claimed");
  journal.cancel("retry");
  journal.releaseBeforeLaunch("retry");
  assert.equal(journal.claim("retry", "digest"), "cancelled");
});
