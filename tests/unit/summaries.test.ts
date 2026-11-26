import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  redactSecrets,
  stripMarkdownToPlainText,
} from '../../src/main/summaries/sanitizer';
import {
  parseAgentAuthoredSummary,
  SummaryPipeline,
} from '../../src/main/summaries/summaryPipeline';

describe('M4 Summary pipeline & secret redaction', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('redacts API keys, Bearer tokens, and long hex strings', () => {
    const raw =
      'Used sk-ant-api03-abcdef1234567890 and Bearer mysecrettokenvalue99 and hash 0123456789abcdef0123456789abcdef';
    const clean = redactSecrets(raw);
    expect(clean).not.toContain('sk-ant-api03-abcdef1234567890');
    expect(clean).not.toContain('mysecrettokenvalue99');
    expect(clean).not.toContain('0123456789abcdef0123456789abcdef');
    expect(clean).toContain('[REDACTED]');
  });

  it('prefers Tier 1 AGENTWATCH_SUMMARY and strips it cleanly', async () => {
    const pipeline = new SummaryPipeline();
    const rawMsg =
      'I applied the schema updates.\n\nAGENTWATCH_SUMMARY: Billing is on usage-based plans. Two migrations applied and all 38 tests pass.';
    const parsed = parseAgentAuthoredSummary(rawMsg);
    expect(parsed.summary).toBe(
      'Billing is on usage-based plans. Two migrations applied and all 38 tests pass.',
    );
    expect(parsed.strippedMessage).toBe('I applied the schema updates.');

    const out = await pipeline.generateSummary(
      {
        id: 'e1',
        type: 'turn_finished',
        agent: 'claude_code',
        sessionId: 's1',
        timestamp: Date.now(),
        cwd: 'C:\\repo\\billing',
        folderName: 'billing',
        lastAssistantMessage: rawMsg,
      },
      { askAgents: true, llmSummarizerEnabled: false },
    );
    expect(out).toBe('Billing is on usage-based plans. Two migrations applied and all 38 tests pass.');
  });

  it('falls back to Tier 2 markdown-stripped local transcript summary when Tier 1 is missing or malformed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-sum-'));
    dirs.push(tmp);
    const transcriptFile = path.join(tmp, 'session.jsonl');
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix tests' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '## Results\n```ts\nconst token = "sk-proj-secret12345678901234";\n```\nFixed the billing retry loop. All 24 unit tests now pass.',
            },
          ],
        },
      }),
    ].join('\n') + '\n';
    fs.writeFileSync(transcriptFile, jsonl, 'utf8');

    const pipeline = new SummaryPipeline();
    const out = await pipeline.generateSummary(
      {
        id: 'e2',
        type: 'turn_finished',
        agent: 'claude_code',
        sessionId: 's2',
        timestamp: Date.now(),
        cwd: 'C:\\repo\\billing',
        folderName: 'billing',
        transcriptPath: transcriptFile,
      },
      { askAgents: true, llmSummarizerEnabled: false },
    );
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out).not.toContain('```');
    expect(out).not.toContain('sk-proj');
    expect(out).toContain('Fixed the billing retry loop.');

    const permOut = await pipeline.generateSummary(
      {
        id: 'e3',
        type: 'permission_requested',
        agent: 'claude_code',
        sessionId: 's2',
        timestamp: Date.now(),
        cwd: 'C:\\repo\\billing',
        folderName: 'billing',
        toolName: 'Bash',
        commandOrAction: 'pnpm test',
      },
      { askAgents: true, llmSummarizerEnabled: false },
    );
    expect(permOut).toBe('Claude Code needs approval to run pnpm test in billing.');
    expect(stripMarkdownToPlainText('**Hello** `world`')).toBe('Hello world');
  });
});
