import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { appendThinkingSuffix } from './run-builder.js';
import {
  supportsExecutionContract,
  supportsOwnedFusionRoutes,
} from './runtime-contract.js';
import type { FusionProfile, FusionRun } from './types.js';
import { isNodeErrorCode, isRecord } from './utils.js';

export interface NativeRecoveryPolicy {
  path: string;
  configured: 'disabled' | 'enabled' | 'unknown';
}

export async function readNativeRecoveryPolicy(
  agentDir = getAgentDir(),
): Promise<NativeRecoveryPolicy> {
  const path = join(agentDir, 'extensions', 'subagent', 'config.json');
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return {
      path,
      configured:
        isRecord(value) && value.autoResume === false
          ? 'disabled'
          : isRecord(value) &&
              (value.autoResume === undefined || value.autoResume === true)
            ? 'enabled'
            : 'unknown',
    };
  } catch (error: unknown) {
    return {
      path,
      configured: isNodeErrorCode(error, 'ENOENT') ? 'enabled' : 'unknown',
    };
  }
}

export function recoveryPolicyError(
  policy: NativeRecoveryPolicy,
): string | undefined {
  return policy.configured === 'disabled'
    ? undefined
    : `Fusion requires native autoResume: false before ordinary workflow launch. Set it in ${policy.path}, preserving other settings, and restart Pi before using Fusion. This affects all subagent workflows. RPC cannot verify an already-running owner's effective policy.`;
}

export function thinkingWarnings(profile: FusionProfile): string[] {
  return [
    ...profile.panel.map((member) => ({
      label: member.label ?? member.id,
      ...member,
    })),
    { label: 'Synthesis', ...profile.judge },
  ]
    .filter((member) => member.thinking && !member.model)
    .map(
      (member) =>
        `${member.label}: thinking=${member.thinking} is not forwarded without an explicit model; native agent/default effort applies.`,
    );
}

export function formatFusionDoctor(input: {
  info?: unknown;
  nativeError?: string;
  policy: NativeRecoveryPolicy;
  profileName?: string;
  profile?: FusionProfile;
  configError?: string;
  trusted: boolean;
  parentTools?: readonly string[];
  active?: FusionRun;
}): string {
  const info = isRecord(input.info) ? input.info : {};
  const capabilities = isRecord(info.capabilities) ? info.capabilities : {};
  const methods = Array.isArray(info.methods)
    ? info.methods.filter(
        (method): method is string => typeof method === 'string',
      )
    : [];
  const lines = [
    '# Fusion diagnostics',
    `- Project trusted: ${input.trusted ? 'yes' : 'no'}`,
    `- Native RPC: ${input.nativeError ?? (input.info ? 'reachable' : 'unavailable')}`,
    `- Advertised methods: ${methods.join(', ') || 'unknown'}`,
    `- Async spawn: ${capabilities.asyncSpawn === true ? 'advertised' : 'not advertised'}`,
    `- Non-recovering steer: ${capabilities.nonRecoveringSteer === true ? 'advertised' : 'not advertised'}`,
    `- Strict lifetime: ${supportsExecutionContract(info) && supportsOwnedFusionRoutes(info) ? 'advertised' : 'unavailable; ordinary stage deadlines only'}`,
    `- Native auto-resume configuration: ${input.policy.configured}`,
    '- Effective owner recovery policy: not queryable through RPC; restart after changing config',
    '- Workflow-script policy and child tool availability: not queryable through RPC',
    `- Recovery config: ${input.policy.path}`,
    `- Profile: ${input.profileName ?? input.configError ?? 'unknown'}`,
  ];
  if (input.profile) {
    lines.push(
      '- Default panel diversity is role-based; different models require explicit selections.',
    );
    for (const member of [
      ...input.profile.panel.map((member) => ({
        label: member.label ?? member.id,
        ...member,
      })),
      { label: 'Synthesis', ...input.profile.judge },
    ])
      lines.push(
        `- ${member.label}: ${appendThinkingSuffix(member.model, member.thinking) ?? 'model/effort inherited from native agent/defaults'}`,
      );
    lines.push(
      ...thinkingWarnings(input.profile).map(
        (warning) => `- Warning: ${warning}`,
      ),
    );
    if (
      input.profile.panel.some((member) =>
        /(?:^|\.)fusion-panelist-(?:web|full)$/.test(member.agent),
      )
    ) {
      const tools = input.parentTools;
      lines.push(
        `- Parent web tools: ${tools ? ['web_search', 'web_contents', 'web_answer', 'web_research'].filter((name) => tools.includes(name)).join(', ') || 'none' : 'unknown'}`,
      );
      lines.push(
        '- Parent tools do not prove child loading. Configure Webfox defaults and credentials for every tool in the selected agent.',
      );
    }
  }
  if (input.active) {
    lines.push(
      `- Active Fusion run: ${input.active.id} (${input.active.phase})`,
    );
    if (input.active.cancellationRequested && input.active.error)
      lines.push(`- Pending cancellation: ${input.active.error}`);
    if (input.active.recoveryRequired)
      lines.push(
        `- Recovery required: ${input.active.recoveryRequired}; no replay or automatic adoption`,
      );
    for (const [stage, id] of [
      ['Panel', input.active.panelRunId ?? input.active.chainRunId],
      ['Synthesis', input.active.judgeRunId],
    ])
      if (id) lines.push(`- ${stage} native ID: ${id}`);
  }
  lines.push(
    '- Native inspection: /subagents-fleet; controls require the exact native run ID.',
  );
  const policyError = recoveryPolicyError(input.policy);
  if (policyError) lines.push(`- Action required: ${policyError}`);
  return lines.join('\n');
}
