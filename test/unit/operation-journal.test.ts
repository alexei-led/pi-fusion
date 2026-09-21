import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FusionOperationJournal } from "../../src/operation-journal.js";
import { requestDigest } from "../../src/runtime-contract.js";

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

test("dispatch admission cannot be changed into never-started evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launcher = new FusionOperationJournal(dir);
  launcher.claim("admitted", "internal", "caller");
  assert.equal(launcher.beginDispatch("admitted", "internal"), true);
  assert.throws(() => launcher.beginDispatch("admitted", "different"), /digest/);
  const cancel = new FusionOperationJournal(dir).cancel("admitted");
  assert.equal(cancel.neverStarted, false);
  assert.equal(cancel.requestDigest, "caller");
  launcher.releaseBeforeLaunch("admitted");
  assert.equal(new FusionOperationJournal(dir).lookup("admitted").neverStarted, false);
  assert.equal(launcher.beginDispatch("admitted", "internal"), false);
});

test("cancel marker crash can finish cancellation but cannot authorize replay", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = new FusionOperationJournal(dir);
  journal.claim("interrupted-cancel", "internal", "caller");
  await writeFile(join(dir, `${requestDigest("interrupted-cancel").slice(7)}.cancel`), "cancelled");
  const restarted = new FusionOperationJournal(dir);
  assert.equal(restarted.lookup("interrupted-cancel").neverStarted, false);
  assert.equal(restarted.lookup("interrupted-cancel").replaySafe, false);
  assert.equal(restarted.beginDispatch("interrupted-cancel", "internal"), false);
  assert.equal(restarted.cancel("interrupted-cancel").neverStarted, true);
});

test("legacy intent and corrupt admission remain fail closed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, `${requestDigest("legacy").slice(7)}.intent`), JSON.stringify({ operationId: "legacy", digest: "old-digest" }));
  const journal = new FusionOperationJournal(dir);
  assert.equal(journal.cancel("legacy").neverStarted, false);
  assert.equal(journal.lookup("legacy").replaySafe, false);
  await writeFile(join(dir, `${requestDigest("corrupt").slice(7)}.admission`), "{");
  assert.throws(() => journal.lookup("corrupt"));
  assert.throws(() => journal.cancel("corrupt"));
  assert.equal(journal.beginDispatch("corrupt", "digest"), false);
});
