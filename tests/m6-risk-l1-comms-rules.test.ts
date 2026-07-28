/**
 * Unit tests for T435: L1 static risk rules for Slack, Google Calendar, and Gmail
 *
 * Tests directly instantiate RiskScoringEngine and pass MCPOperation objects
 * with the appropriate tool names. This avoids the MCPStdioProxy setting
 * op.tool = 'mcp', which would silence all tool-specific rules.
 */
import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

function makeOp(tool: string, method: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'test-agent',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'test-session',
  };
}

const engine = new RiskScoringEngine();

// ── Slack rules ───────────────────────────────────────────────────────────────

describe('L1 Slack rules', () => {

  it('L1_SLACK_SEND fires for send_message (score 0.7)', async () => {
    const result = await engine.assess(makeOp('slack', 'send_message', { channel: '#general', text: 'hi' }));
    expect(result.triggeredRules).toContain('L1_SLACK_SEND');
    expect(result.staticScore).toBeCloseTo(0.7, 5);
  });

  it('L1_SLACK_SEND fires for post_message (contains "post")', async () => {
    const result = await engine.assess(makeOp('slack', 'post_message', { channel: '#dev' }));
    expect(result.triggeredRules).toContain('L1_SLACK_SEND');
    expect(result.staticScore).toBeCloseTo(0.7, 5);
  });

  it('L1_SLACK_SEND fires for reply_to_thread (contains "reply")', async () => {
    const result = await engine.assess(makeOp('slack', 'reply_to_thread', { ts: '123' }));
    expect(result.triggeredRules).toContain('L1_SLACK_SEND');
    expect(result.staticScore).toBeCloseTo(0.7, 5);
  });

  it('L1_SLACK_DELETE fires for delete_message (score 0.8)', async () => {
    const result = await engine.assess(makeOp('slack', 'delete_message', { ts: '123' }));
    expect(result.triggeredRules).toContain('L1_SLACK_DELETE');
    expect(result.staticScore).toBeCloseTo(0.8, 5);
  });

  it('L1_SLACK_DELETE fires for remove_reaction (contains "remove"), wins over L1_DELETE_RECORD', async () => {
    // L1_SLACK_DELETE = 0.8; L1_DELETE_RECORD also fires for non-filesystem tool with "remove" (0.75)
    // Math.max(0.8, 0.75) = 0.8
    const result = await engine.assess(makeOp('slack', 'remove_reaction', {}));
    expect(result.triggeredRules).toContain('L1_SLACK_DELETE');
    expect(result.staticScore).toBeCloseTo(0.8, 5);
  });

  it('L1_SLACK_READ fires for list_channels (score 0.05)', async () => {
    const result = await engine.assess(makeOp('slack', 'list_channels', {}));
    expect(result.triggeredRules).toContain('L1_SLACK_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_SLACK_READ fires for get_channel_info (starts with "get")', async () => {
    const result = await engine.assess(makeOp('slack', 'get_channel_info', {}));
    expect(result.triggeredRules).toContain('L1_SLACK_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_SLACK_READ fires for search_messages (starts with "search")', async () => {
    const result = await engine.assess(makeOp('slack', 'search_messages', { query: 'hello' }));
    expect(result.triggeredRules).toContain('L1_SLACK_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('Slack rules do NOT fire for non-slack tools', async () => {
    const result = await engine.assess(makeOp('github', 'send_message', {}));
    expect(result.triggeredRules).not.toContain('L1_SLACK_SEND');
    expect(result.triggeredRules).not.toContain('L1_SLACK_DELETE');
    expect(result.triggeredRules).not.toContain('L1_SLACK_READ');
  });

});

// ── Google Calendar rules ─────────────────────────────────────────────────────

describe('L1 Google Calendar rules', () => {

  it('L1_GCAL_CREATE fires for create_event (score 0.4)', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'create_event', { summary: 'Standup' }));
    expect(result.triggeredRules).toContain('L1_GCAL_CREATE');
    expect(result.staticScore).toBeCloseTo(0.4, 5);
  });

  it('L1_GCAL_CREATE fires for insert_event (contains "insert")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'insert_event', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_CREATE');
    expect(result.staticScore).toBeCloseTo(0.4, 5);
  });

  it('L1_GCAL_CREATE fires for add_attendee (contains "add")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'add_attendee', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_CREATE');
    expect(result.staticScore).toBeCloseTo(0.4, 5);
  });

  it('L1_GCAL_UPDATE fires for update_event (score 0.5)', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'update_event', { eventId: 'abc' }));
    expect(result.triggeredRules).toContain('L1_GCAL_UPDATE');
    expect(result.staticScore).toBeCloseTo(0.5, 5);
  });

  it('L1_GCAL_UPDATE fires for patch_event (contains "patch")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'patch_event', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_UPDATE');
    expect(result.staticScore).toBeCloseTo(0.5, 5);
  });

  it('L1_GCAL_UPDATE fires for modify_event (contains "modify")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'modify_event', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_UPDATE');
    expect(result.staticScore).toBeCloseTo(0.5, 5);
  });

  it('L1_GCAL_DELETE fires for delete_event (score 0.75 — max with L1_DELETE_RECORD)', async () => {
    // L1_GCAL_DELETE = 0.7; L1_DELETE_RECORD also fires for any non-filesystem tool with "delete" (0.75)
    // Math.max(0.7, 0.75) = 0.75
    const result = await engine.assess(makeOp('google-calendar', 'delete_event', { eventId: 'abc' }));
    expect(result.triggeredRules).toContain('L1_GCAL_DELETE');
    expect(result.triggeredRules).toContain('L1_DELETE_RECORD');
    expect(result.staticScore).toBeCloseTo(0.75, 5);
  });

  it('L1_GCAL_DELETE fires for cancel_event (contains "cancel")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'cancel_event', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_DELETE');
    expect(result.staticScore).toBeCloseTo(0.7, 5);
  });

  it('L1_GCAL_READ fires for list_events (score 0.05)', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'list_events', {}));
    expect(result.triggeredRules).toContain('L1_GCAL_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_GCAL_READ fires for get_event (starts with "get")', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'get_event', { eventId: 'abc' }));
    expect(result.triggeredRules).toContain('L1_GCAL_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_GCAL_CREATE does NOT fire for delete_event', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'delete_event', {}));
    expect(result.triggeredRules).not.toContain('L1_GCAL_CREATE');
    expect(result.triggeredRules).not.toContain('L1_GCAL_UPDATE');
  });

  it('Google Calendar rules do NOT fire for non-gcal tools', async () => {
    const result = await engine.assess(makeOp('slack', 'create_event', {}));
    expect(result.triggeredRules).not.toContain('L1_GCAL_CREATE');
    expect(result.triggeredRules).not.toContain('L1_GCAL_UPDATE');
    expect(result.triggeredRules).not.toContain('L1_GCAL_DELETE');
    expect(result.triggeredRules).not.toContain('L1_GCAL_READ');
  });

});

// ── Gmail rules ───────────────────────────────────────────────────────────────

describe('L1 Gmail rules', () => {

  it('L1_GMAIL_SEND fires for send_email (score 0.9)', async () => {
    const result = await engine.assess(makeOp('gmail', 'send_email', { to: 'a@b.com' }));
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
    expect(result.staticScore).toBeCloseTo(0.9, 5);
  });

  it('L1_GMAIL_SEND fires for reply_to_email (contains "reply")', async () => {
    const result = await engine.assess(makeOp('gmail', 'reply_to_email', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
    expect(result.staticScore).toBeCloseTo(0.9, 5);
  });

  it('L1_GMAIL_SEND fires for forward_email (contains "forward")', async () => {
    const result = await engine.assess(makeOp('gmail', 'forward_email', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
    expect(result.staticScore).toBeCloseTo(0.9, 5);
  });

  it('L1_GMAIL_DELETE fires for delete_email (score 0.85)', async () => {
    const result = await engine.assess(makeOp('gmail', 'delete_email', { messageId: 'msg1' }));
    expect(result.triggeredRules).toContain('L1_GMAIL_DELETE');
    expect(result.staticScore).toBeCloseTo(0.85, 5);
  });

  it('L1_GMAIL_DELETE fires for trash_email (contains "trash")', async () => {
    const result = await engine.assess(makeOp('gmail', 'trash_email', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_DELETE');
    expect(result.staticScore).toBeCloseTo(0.85, 5);
  });

  it('L1_GMAIL_DRAFT fires for create_draft (score 0.3)', async () => {
    const result = await engine.assess(makeOp('gmail', 'create_draft', { body: 'hello' }));
    expect(result.triggeredRules).toContain('L1_GMAIL_DRAFT');
    expect(result.staticScore).toBeCloseTo(0.3, 5);
  });

  it('L1_GMAIL_DRAFT fires for compose_message (contains "compose")', async () => {
    const result = await engine.assess(makeOp('gmail', 'compose_message', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_DRAFT');
    expect(result.staticScore).toBeCloseTo(0.3, 5);
  });

  it('L1_GMAIL_DRAFT fires for update_draft (contains "draft")', async () => {
    const result = await engine.assess(makeOp('gmail', 'update_draft', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_DRAFT');
    expect(result.staticScore).toBeCloseTo(0.3, 5);
  });

  it('L1_GMAIL_DRAFT does NOT fire for send_draft (negative check: "send" disqualifies draft rule)', async () => {
    // send_draft contains "send" → should be caught by L1_GMAIL_SEND, not L1_GMAIL_DRAFT
    const result = await engine.assess(makeOp('gmail', 'send_draft', {}));
    expect(result.triggeredRules).not.toContain('L1_GMAIL_DRAFT');
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
    expect(result.staticScore).toBeCloseTo(0.9, 5);
  });

  it('L1_GMAIL_DRAFT does NOT fire for reply_draft (negative check: "reply" disqualifies draft rule)', async () => {
    const result = await engine.assess(makeOp('gmail', 'reply_draft', {}));
    expect(result.triggeredRules).not.toContain('L1_GMAIL_DRAFT');
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
  });

  it('L1_GMAIL_READ fires for list_emails (score 0.05)', async () => {
    const result = await engine.assess(makeOp('gmail', 'list_emails', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_GMAIL_READ fires for get_email (starts with "get")', async () => {
    const result = await engine.assess(makeOp('gmail', 'get_email', { messageId: 'msg1' }));
    expect(result.triggeredRules).toContain('L1_GMAIL_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('L1_GMAIL_READ fires for search_emails (starts with "search")', async () => {
    const result = await engine.assess(makeOp('gmail', 'search_emails', { q: 'subject:hello' }));
    expect(result.triggeredRules).toContain('L1_GMAIL_READ');
    expect(result.staticScore).toBeCloseTo(0.05, 5);
  });

  it('Gmail rules do NOT fire for non-gmail tools', async () => {
    const result = await engine.assess(makeOp('slack', 'send_email', {}));
    expect(result.triggeredRules).not.toContain('L1_GMAIL_SEND');
    expect(result.triggeredRules).not.toContain('L1_GMAIL_DELETE');
    expect(result.triggeredRules).not.toContain('L1_GMAIL_DRAFT');
    expect(result.triggeredRules).not.toContain('L1_GMAIL_READ');
  });

});

// ── Cross-tool isolation ───────────────────────────────────────────────────────

describe('L1 comms rules — cross-tool isolation', () => {

  it('Slack delete and L1_DELETE_RECORD both fire — Math.max wins (0.8)', async () => {
    // L1_DELETE_RECORD fires for any tool (!= filesystem) containing "delete" or "remove" (score 0.75)
    // L1_SLACK_DELETE fires for slack + "delete" (score 0.8)
    // Math.max(0.75, 0.8) = 0.8
    const result = await engine.assess(makeOp('slack', 'delete_message', {}));
    expect(result.triggeredRules).toContain('L1_SLACK_DELETE');
    expect(result.triggeredRules).toContain('L1_DELETE_RECORD');
    expect(result.staticScore).toBeCloseTo(0.8, 5);
  });

  it('Gmail send and L1_DELETE_RECORD do NOT overlap (send != delete)', async () => {
    const result = await engine.assess(makeOp('gmail', 'send_email', {}));
    expect(result.triggeredRules).toContain('L1_GMAIL_SEND');
    expect(result.triggeredRules).not.toContain('L1_DELETE_RECORD');
    expect(result.staticScore).toBeCloseTo(0.9, 5);
  });

  it('Unknown slack method falls through to DEFAULT score (0.2)', async () => {
    // update_profile: not send/post/reply, not delete/remove, not read-only
    const result = await engine.assess(makeOp('slack', 'update_profile', {}));
    expect(result.triggeredRules).not.toContain('L1_SLACK_SEND');
    expect(result.triggeredRules).not.toContain('L1_SLACK_DELETE');
    expect(result.triggeredRules).not.toContain('L1_SLACK_READ');
    // update contains no keyword matching default read rules, no sensitive path → DEFAULT
    expect(result.staticScore).toBeCloseTo(0.2, 5);
  });

  it('firedRuleDetails contains correct layer and description for L1_GMAIL_SEND', async () => {
    const result = await engine.assess(makeOp('gmail', 'send_email', {}));
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_GMAIL_SEND');
    expect(fired).toBeDefined();
    expect(fired?.layer).toBe('L1');
    expect(fired?.score).toBeCloseTo(0.9, 5);
    expect(fired?.description).toContain('cannot be recalled');
  });

  it('firedRuleDetails contains correct layer and description for L1_GCAL_DELETE', async () => {
    const result = await engine.assess(makeOp('google-calendar', 'delete_event', {}));
    const fired = result.firedRuleDetails.find(r => r.id === 'L1_GCAL_DELETE');
    expect(fired).toBeDefined();
    expect(fired?.layer).toBe('L1');
    expect(fired?.score).toBeCloseTo(0.7, 5);
  });

  it('tools falling through default are not confused by new comms rules', async () => {
    // 'database' tool with 'create_record' — should not match Slack/GCal/Gmail rules
    const result = await engine.assess(makeOp('database', 'create_record', {}));
    expect(result.triggeredRules).not.toContain('L1_SLACK_SEND');
    expect(result.triggeredRules).not.toContain('L1_GCAL_CREATE');
    expect(result.triggeredRules).not.toContain('L1_GMAIL_DRAFT');
  });

});
