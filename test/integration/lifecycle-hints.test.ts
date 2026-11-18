import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SUBAGENTS_RPC_REQUEST_CHANNEL } from '../../src/subagents-rpc.js';
import { isRecord } from '../../src/utils.js';
import { FakePi, nextTick } from '../support/fake-pi.js';
import { mountFusion } from '../support/fusion-extension-fixture.js';

function statusRequests(pi: FakePi): number {
  return pi.events.emitted.filter(
    ({ event, payload }) =>
      event === SUBAGENTS_RPC_REQUEST_CHANNEL &&
      isRecord(payload) &&
      payload.method === 'status',
  ).length;
}

for (const event of ['subagent:child-status', 'subagent:process-terminal']) {
  test(`${event} is only a hint, coalesces duplicates, and cleans up on shutdown`, async (t) => {
    const { pi, start, close } = await mountFusion(t);
    await start();
    assert.equal(pi.events.listenerCount(event), 1);
    const before = statusRequests(pi);
    pi.events.emit(event, {
      version: 1,
      runId: 'unrelated',
      state: 'complete',
    });
    await nextTick();
    assert.equal(statusRequests(pi), before);
    for (let i = 0; i < 5; i++)
      pi.events.emit(event, {
        version: 1,
        runId: 'panel-1',
        state: 'complete',
        output: 'not evidence',
      });
    await nextTick();
    assert.equal(statusRequests(pi), before + 1);
    assert.equal(pi.events.spawns.length, 1);
    pi.events.statusResults.set('panel-1', {
      runId: 'panel-1',
      state: 'complete',
      results: [1, 2, 3].map(() => ({
        agent: 'pi-fusion.fusion-panelist',
        success: true,
        output: 'review',
      })),
    });
    pi.events.emit(event, { version: 1, runId: 'panel-1', state: 'observed' });
    await nextTick();
    assert.equal(pi.events.spawns.length, 2);
    pi.events.emit(event, { version: 1, runId: 'panel-1' });
    await nextTick();
    assert.equal(pi.events.spawns.length, 2);
    const after = statusRequests(pi);
    pi.events.emit(event, { version: 1, runId: 'judge-1' });
    await close();
    await nextTick();
    assert.equal(pi.events.listenerCount(event), 0);
    assert.equal(statusRequests(pi), after);
  });
}

test('a hint during an in-flight status request schedules one fresh pass', async (t) => {
  const { pi, start } = await mountFusion(t, { restoreSession: false });
  await start();
  const emit = pi.events.emit.bind(pi.events);
  let held: { requestId: string; method: string } | undefined;
  let requests = 0;
  pi.events.emit = (event, payload) => {
    if (
      event === SUBAGENTS_RPC_REQUEST_CHANNEL &&
      isRecord(payload) &&
      typeof payload.requestId === 'string' &&
      payload.method === 'status' &&
      ++requests === 1
    ) {
      held = { requestId: payload.requestId, method: payload.method };
      return;
    }
    emit(event, payload);
  };
  emit('subagent:child-status', { runId: 'panel-1' });
  await nextTick();
  assert.ok(held);
  for (let i = 0; i < 5; i++)
    emit('subagent:child-status', { runId: 'panel-1' });
  await nextTick();
  assert.equal(requests, 1);
  emit(`subagents:rpc:v1:reply:${held.requestId}`, {
    version: 1,
    requestId: held.requestId,
    method: 'status',
    success: true,
    data: { runId: 'panel-1', results: [] },
  });
  await nextTick();
  assert.equal(requests, 2);
});

test('unadvertised lifecycle channels are not subscribed', async (t) => {
  const pi = new FakePi();
  pi.events.pingResult = { ok: true };
  const { start } = await mountFusion(t, { pi, restoreSession: false });
  await start();
  assert.equal(pi.events.listenerCount('subagent:child-status'), 0);
});

test('id-less jobs changes refresh once and never become completion evidence', async (t) => {
  const pi = new FakePi();
  pi.events.pingResult = { events: { jobsChanged: 'subagent:jobs-changed' } };
  const { start, close } = await mountFusion(t, { pi, restoreSession: false });
  await start();
  const before = statusRequests(pi);
  pi.events.emit('subagent:jobs-changed', { version: 2 });
  await nextTick();
  assert.equal(statusRequests(pi), before);
  for (let index = 0; index < 5; index++)
    pi.events.emit('subagent:jobs-changed', {
      version: 1,
      output: 'not evidence',
    });
  await nextTick();
  assert.equal(statusRequests(pi), before + 1);
  assert.equal(pi.events.spawns.length, 1);
  await close();
  assert.equal(pi.events.listenerCount('subagent:jobs-changed'), 0);
});
