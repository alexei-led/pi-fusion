import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFusionInit } from "../../src/commands.js";
import {
  createDefaultFusionConfig,
  getGlobalFusionConfigPath,
  getProjectFusionConfigPath,
  loadFusionConfig,
  resolveProfile,
} from "../../src/config.js";
import type { FusionConfig } from "../../src/types.js";

const PANEL_MEMBER = {
  id: "one",
  label: "One",
  agent: "pi-fusion.fusion-panelist",
};

const JUDGE = { agent: "pi-fusion.fusion-judge" };

test("loadFusionConfig returns the default quality profile when no config exists", async () => {
  const missingReader = async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };

  const config = await loadFusionConfig(
    { cwd: "/project", isProjectTrusted: () => true },
    { agentDir: "/agent", readTextFile: missingReader },
  );

  assert.equal(config.defaultProfile, "quality");
  const profile = config.profiles.quality;
  assert.ok(profile);
  assert.equal(profile.panel.length, 3);
  assert.equal(profile.judge.agent, "pi-fusion.fusion-judge");
  assert.equal(profile.context, "fresh");
});

test("loadFusionConfig prefers trusted project config over global config", async (t) => {
  const root = await makeTempDir(t);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await writeJson(
    getProjectFusionConfigPath(cwd),
    configWithProfile("project"),
  );
  await writeJson(
    getGlobalFusionConfigPath(agentDir),
    configWithProfile("global"),
  );

  const config = await loadFusionConfig(
    { cwd, isProjectTrusted: () => true },
    { agentDir },
  );

  assert.equal(config.defaultProfile, "project");
  assert.ok(config.profiles.project);
});

test("loadFusionConfig ignores project config when the project is untrusted", async (t) => {
  const root = await makeTempDir(t);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await writeJson(
    getProjectFusionConfigPath(cwd),
    configWithProfile("project"),
  );
  await writeJson(
    getGlobalFusionConfigPath(agentDir),
    configWithProfile("global"),
  );

  const config = await loadFusionConfig(
    { cwd, isProjectTrusted: () => false },
    { agentDir },
  );

  assert.equal(config.defaultProfile, "global");
  assert.ok(config.profiles.global);
  assert.equal(config.profiles.project, undefined);
});

test("loadFusionConfig resolves Claude alias shorthand in panel and judge models", async (t) => {
  const root = await makeTempDir(t);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");

  await writeJson(join(agentDir, "claude-alias.json"), {
    aliases: [
      { slug: "work", handle: "claude-work", label: "Work" },
      { slug: "labs", handle: "claude-labs", label: "Labs" },
    ],
  });
  await writeJson(getProjectFusionConfigPath(cwd), {
    defaultProfile: "quality",
    profiles: {
      quality: {
        panel: [
          { ...PANEL_MEMBER, model: "claude-work/opus-4.8" },
          { ...PANEL_MEMBER, id: "two", label: "Two", model: "claude-labs/claude-sonnet-4-6" },
        ],
        judge: { ...JUDGE, model: "claude-work/haiku-4.5" },
      },
    },
  });

  const config = await loadFusionConfig(
    { cwd, isProjectTrusted: () => true },
    { agentDir },
  );

  const profile = config.profiles.quality;
  assert.ok(profile);
  assert.equal(profile.panel[0]?.model, "anthropic-work/claude-opus-4-8");
  assert.equal(profile.panel[1]?.model, "anthropic-labs/claude-sonnet-4-6");
  assert.equal(profile.judge.model, "anthropic-work/claude-haiku-4-5");
});

test("loadFusionConfig rejects duplicate Claude handles across global and project aliases", async (t) => {
  const root = await makeTempDir(t);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");

  await writeJson(join(agentDir, "claude-alias.json"), {
    aliases: [{ slug: "work", handle: "claude-shared", label: "Work" }],
  });
  await writeJson(getProjectFusionConfigPath(cwd), configWithProfile("quality"));
  await writeJson(join(cwd, ".pi", "claude-alias.json"), {
    aliases: [{ slug: "client", handle: "claude-shared", label: "Client" }],
  });

  await assert.rejects(
    loadFusionConfig({ cwd, isProjectTrusted: () => true }, { agentDir }),
    /Duplicate Claude alias handle "claude-shared" across merged config/,
  );
});

test("loadFusionConfig fails on malformed JSON", async (t) => {
  const root = await makeTempDir(t);
  const agentDir = join(root, "agent");
  const path = getGlobalFusionConfigPath(agentDir);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path, "{", "utf8");

  await assert.rejects(
    loadFusionConfig(
      { cwd: join(root, "project"), isProjectTrusted: () => false },
      { agentDir },
    ),
    /Invalid JSON in fusion config/,
  );
});

test("loadFusionConfig fails on invalid config shape", async (t) => {
  const root = await makeTempDir(t);
  const agentDir = join(root, "agent");
  await writeJson(getGlobalFusionConfigPath(agentDir), {
    defaultProfile: "bad",
    profiles: {
      bad: { panel: [{ id: "missing-fields" }], judge: JUDGE },
    },
  });

  await assert.rejects(
    loadFusionConfig(
      { cwd: join(root, "project"), isProjectTrusted: () => false },
      { agentDir },
    ),
    /Invalid fusion config/,
  );
});

test("resolveProfile returns requested and default profiles", () => {
  const config: FusionConfig = {
    defaultProfile: "quality",
    profiles: {
      quality: { panel: [PANEL_MEMBER], judge: JUDGE },
      fast: { panel: [{ ...PANEL_MEMBER, id: "fast" }], judge: JUDGE },
    },
  };

  assert.equal(resolveProfile(config).name, "quality");
  assert.equal(resolveProfile(config, "fast").name, "fast");
});

test("resolveProfile reports unknown profiles and empty panels", () => {
  const config: FusionConfig = {
    defaultProfile: "empty",
    profiles: {
      empty: { panel: [], judge: JUDGE },
    },
  };

  assert.throws(
    () => resolveProfile(config, "missing"),
    /Unknown fusion profile "missing"/,
  );
  assert.throws(() => resolveProfile(config), /at least one panel member/);
});

test("runFusionInit writes a trusted project template", async (t) => {
  const root = await makeTempDir(t);
  const notifications: string[] = [];

  const result = await runFusionInit({
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => true,
      notify: (message) => notifications.push(message),
    },
  });

  assert.equal(result.status, "written");
  const config = JSON.parse(
    await readFile(getProjectFusionConfigPath(root), "utf8"),
  ) as unknown;
  assert.deepEqual(config, createDefaultFusionConfig());
  assert.equal(notifications.length, 1);
});

test("runFusionInit skips untrusted projects and protects existing config without confirmation", async (t) => {
  const root = await makeTempDir(t);
  const configPath = getProjectFusionConfigPath(root);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, "existing", "utf8");
  const notifications: string[] = [];

  const untrusted = await runFusionInit({
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => false,
    ui: {
      confirm: async () => true,
      notify: (message) => notifications.push(message),
    },
  });
  assert.deepEqual(untrusted, { status: "skipped", reason: "untrusted" });
  assert.equal(await readFile(configPath, "utf8"), "existing");

  const cancelled = await runFusionInit({
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => false,
      notify: (message) => notifications.push(message),
    },
  });
  assert.equal(cancelled.status, "skipped");
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(await readFile(configPath, "utf8"), "existing");
});

function configWithProfile(name: string): FusionConfig {
  return {
    defaultProfile: name,
    profiles: {
      [name]: {
        panel: [{ ...PANEL_MEMBER, id: name, label: name }],
        judge: JUDGE,
      },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

interface TestContext {
  after(callback: () => void | Promise<void>): void;
}

async function makeTempDir(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-fusion-"));
  t.after(async () => {
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
