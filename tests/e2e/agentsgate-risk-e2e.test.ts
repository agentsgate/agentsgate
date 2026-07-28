/**
 * E2E tests for M6 (RiskScoringEngine) + M7 (InterventionController) via MCPStdioProxy.
 *
 * MCPStdioProxy always sets operation.tool = 'mcp', so:
 *   FIRES:    L1_EXECUTE_COMMAND, L1_DROP_TABLE, L1_DELETE_RECORD,
 *             L1_SENSITIVE_PATH_WRITE, L1_SENSITIVE_FILE_TYPE, L1_READ_ONLY, DEFAULT
 *   SILENCED: L1_DELETE_FILE, L1_OVERWRITE_FILE, L1_GIT_FORCE_PUSH (require specific tool values)
 *
 * Intervention thresholds (default): allowBelow=0.3, blockAtOrAbove=0.7
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpClientHarness } from '../helpers/mcp-client-harness.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';

let h: McpClientHarness;

afterEach(async () => { await h?.stop(); });

function makePipeline(thresholds: { allowBelow?: number; blockAtOrAbove?: number } = {}) {
  return createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(thresholds),
  });
}

// ── 1. Block decisions ────────────────────────────────────────────────────────

describe('M6 L1 rules — block decisions', () => {

  it('L1_EXECUTE_COMMAND fires for execute_command (score 0.8 → block)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'execute_command', arguments: { cmd: 'ls' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.action).toBe('block');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

  it('L1_EXECUTE_COMMAND fires for shell_run (contains "shell")', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'shell_run', arguments: {} });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

  it('L1_DROP_TABLE fires for drop_table (score 0.95 → block)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'drop_table', arguments: { table: 'users' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.95, 5);
  });

  it('L1_DROP_TABLE fires for truncate_data (contains "truncate")', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'truncate_data', arguments: {} });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.95, 5);
  });

  it('L1_DELETE_RECORD fires for delete_record (score 0.75 → block)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'delete_record', arguments: { id: '42' } });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.75, 5);
  });

  it('L1_SENSITIVE_PATH_WRITE fires for write_config with .env path (score 0.9 → block)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', {
      name: 'write_config',
      arguments: { path: '/app/.env', content: 'SECRET=xyz' },
    });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.9, 5);
  });

  it('L1_SENSITIVE_FILE_TYPE fires for update_file with .pem path (score 0.75 → block)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', {
      name: 'update_file',
      arguments: { path: '/certs/server.pem', content: '...' },
    });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.75, 5);
  });

  it('highest score wins when multiple L1 rules fire', async () => {
    // 'execute_and_drop_table' contains 'execute' (0.8) and 'drop' (0.95) → max = 0.95
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    const resp = await h.request('tools/call', { name: 'execute_and_drop_table', arguments: {} });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.95, 5);
  });

});

// ── 2. Allow decisions ────────────────────────────────────────────────────────

describe('M6 L1 rules — allow decisions', () => {

  it('L1_READ_ONLY fires for get_status (score 0.05 → allow)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'get_status', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.05, 5);
  });

  it('L1_READ_ONLY fires for list_files (score 0.05 → allow)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'list_files', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.05, 5);
  });

  it('L1_READ_ONLY fires for stat (score 0.05 → allow)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'stat', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.05, 5);
  });

  it('DEFAULT score (0.2) applies to unknown methods — forwarded to server', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // echo hits no L1 rule → DEFAULT=0.2 → allow; fake server handles it
    const result = await h.callTool('echo', { message: 'risk-default' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('risk-default');
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.2, 5);
  });

  it('L1_DELETE_FILE does NOT fire under stdio proxy (tool=mcp, not filesystem)', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // delete_file would score 0.9 under filesystem tool, but tool='mcp' → L1_DELETE_FILE silent
    // delete_record (0.75) fires instead, which still blocks — so use a method that only
    // matches L1_DELETE_FILE but NOT L1_DELETE_RECORD (avoid 'delete'/'remove' keywords)
    // 'rm_file' would need tool=filesystem to match L1_DELETE_FILE; it doesn't match any rule
    // → DEFAULT=0.2 → allow
    await h.request('tools/call', { name: 'rm_file', arguments: { path: '/tmp/test.txt' } });
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.2, 5);
  });

});

// ── 3. Triggered rule IDs surface in the decision ─────────────────────────────

describe('M6 rule transparency — triggered rule IDs in decision', () => {

  it('decision.reasons includes L1_EXECUTE_COMMAND rule ID', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'exec_script', arguments: {} });
    const reasons = h.lastIntercept?.decision.reasons ?? [];
    expect(reasons.some(r => r.includes('L1_EXECUTE_COMMAND'))).toBe(true);
  });

  it('decision.reasons includes L1_DROP_TABLE rule ID', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'truncate_data', arguments: {} });
    const reasons = h.lastIntercept?.decision.reasons ?? [];
    expect(reasons.some(r => r.includes('L1_DROP_TABLE'))).toBe(true);
  });

  it('decision.reasons includes L1_DELETE_RECORD rule ID', async () => {
    const pipeline = makePipeline();
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    await h.request('tools/call', { name: 'delete_record', arguments: {} });
    const reasons = h.lastIntercept?.decision.reasons ?? [];
    expect(reasons.some(r => r.includes('L1_DELETE_RECORD'))).toBe(true);
  });

});

// ── 4. Custom intervention thresholds ─────────────────────────────────────────

describe('M7 custom intervention thresholds', () => {

  it('DEFAULT score (0.2) triggers require_approval when allowBelow=0.15', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.15, blockAtOrAbove: 0.5 }),
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // echo → DEFAULT=0.2; 0.15 ≤ 0.2 < 0.5 → require_approval; server still receives call
    const result = await h.callTool('echo', { message: 'threshold-test' });
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('threshold-test');
    expect(h.lastIntercept?.decision.action).toBe('require_approval');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.2, 5);
  });

  it('execute_command is require_approval when blockAtOrAbove raised to 0.9', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController({ allowBelow: 0.5, blockAtOrAbove: 0.9 }),
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // execute_command → L1_EXECUTE_COMMAND=0.8; 0.5 ≤ 0.8 < 0.9 → require_approval
    await h.request('tools/call', { name: 'execute_command', arguments: {} });
    expect(h.lastIntercept?.decision.action).toBe('require_approval');
    expect(h.lastIntercept?.decision.riskScore).toBeCloseTo(0.8, 5);
  });

});
