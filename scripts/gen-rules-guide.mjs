/**
 * Generates docs/agentsgate-rules-guide.docx
 * Run: node scripts/gen-rules-guide.mjs
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType,
  PageBreak,
} from 'docx';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'agentsgate-rules-guide.docx');

// ── colour palette ─────────────────────────────────────────────────────────
const C = {
  heading1:   '1F3864', // dark navy
  heading2:   '2E4057', // steel
  heading3:   '2F6690', // medium blue
  accent:     '3B82F6', // bright blue
  codeBg:     'F1F5F9', // light slate
  codeText:   '1E293B',
  tableHead:  '1F3864',
  tableHeadFg:'FFFFFF',
  tableAlt:   'EFF6FF',
  block:      'FEE2E2', // red tint
  approve:    'FEF9C3', // yellow tint
  allow:      'DCFCE7', // green tint
  border:     'CBD5E1',
  tip:        'DBEAFE',
  tipBorder:  '3B82F6',
};

// ── helpers ─────────────────────────────────────────────────────────────────
const bold   = (text, opts = {}) => new TextRun({ text, bold: true, ...opts });
const normal = (text, opts = {}) => new TextRun({ text, ...opts });
const nbsp   = ()                => new TextRun('\u00A0');

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160 },
    children: [new TextRun({ text, bold: true, color: C.heading1, size: 36 })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text, bold: true, color: C.heading2, size: 28 })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text, bold: true, color: C.heading3, size: 24 })],
  });
}
function h4(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_4,
    spacing: { before: 200, after: 60 },
    children: [new TextRun({ text, bold: true, color: C.heading3, size: 22 })],
  });
}
function para(runs, opts = {}) {
  const children = typeof runs === 'string' ? [new TextRun(runs)] : runs;
  return new Paragraph({ children, spacing: { after: 120 }, ...opts });
}
function bullet(runs, level = 0) {
  const children = typeof runs === 'string' ? [new TextRun(runs)] : runs;
  return new Paragraph({
    bullet: { level },
    children,
    spacing: { after: 80 },
  });
}
function code(lines) {
  return lines.map((line, i) =>
    new Paragraph({
      children: [new TextRun({
        text: line,
        font: 'Courier New',
        size: 18,
        color: C.codeText,
      })],
      shading: { type: ShadingType.SOLID, color: C.codeBg, fill: C.codeBg },
      spacing: { before: i === 0 ? 100 : 0, after: i === lines.length - 1 ? 100 : 0 },
      indent: { left: 360 },
    })
  );
}
function inlineCode(text) {
  return new TextRun({ text: ` ${text} `, font: 'Courier New', size: 18,
    color: C.codeText, shading: { type: ShadingType.SOLID, color: C.codeBg, fill: C.codeBg } });
}
function tip(runs) {
  const children = typeof runs === 'string' ? [new TextRun({ text: '💡 ', bold: true }), new TextRun(runs)] : runs;
  return new Paragraph({
    children,
    spacing: { before: 120, after: 120 },
    indent: { left: 360, right: 360 },
    shading: { type: ShadingType.SOLID, color: C.tip, fill: C.tip },
  });
}
function spacer(pts = 120) {
  return new Paragraph({ children: [], spacing: { before: pts } });
}

// ── table builder ───────────────────────────────────────────────────────────
function makeTable(headers, rows, colWidths) {
  const noBorder = {
    top:    { style: BorderStyle.NONE, size: 0, color: 'auto' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    left:   { style: BorderStyle.NONE, size: 0, color: 'auto' },
    right:  { style: BorderStyle.NONE, size: 0, color: 'auto' },
  };
  const thinBorder = {
    top:    { style: BorderStyle.SINGLE, size: 4, color: C.border },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: C.border },
    left:   { style: BorderStyle.SINGLE, size: 4, color: C.border },
    right:  { style: BorderStyle.SINGLE, size: 4, color: C.border },
  };

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: h, bold: true, color: C.tableHeadFg, size: 20 })],
          alignment: AlignmentType.LEFT,
        })],
        width: { size: colWidths[i], type: WidthType.DXA },
        shading: { type: ShadingType.SOLID, color: C.tableHead, fill: C.tableHead },
        borders: noBorder,
      })
    ),
  });

  const dataRows = rows.map((row, ri) =>
    new TableRow({
      children: row.map((cell, ci) => {
        const children = Array.isArray(cell)
          ? cell.map(run => new Paragraph({ children: [run], spacing: { after: 40 } }))
          : [new Paragraph({ children: [new TextRun({ text: cell, size: 20 })], spacing: { after: 40 } })];
        return new TableCell({
          children,
          width: { size: colWidths[ci], type: WidthType.DXA },
          shading: ri % 2 === 1
            ? { type: ShadingType.SOLID, color: C.tableAlt, fill: C.tableAlt }
            : { type: ShadingType.CLEAR, fill: 'auto' },
          borders: { ...noBorder, bottom: { style: BorderStyle.SINGLE, size: 2, color: C.border } },
        });
      }),
    })
  );

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 9000, type: WidthType.DXA },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  DOCUMENT CONTENT
// ─────────────────────────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22 } },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
      },
    },
    children: [

      // ═══════════════════════════════════════════════════════════════════════
      //  COVER
      // ═══════════════════════════════════════════════════════════════════════
      new Paragraph({
        spacing: { before: 1200, after: 200 },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'AgentsGate', bold: true, size: 72, color: C.heading1 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: 'Rules & Policy — Beginner\'s Guide', size: 40, color: C.heading2 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: 'ルール＆ポリシー — 入門ガイド', size: 32, color: C.heading3 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 800 },
        children: [new TextRun({ text: 'Version 1.0  ·  March 2026', color: '64748B', size: 22 })],
      }),

      // ═══════════════════════════════════════════════════════════════════════
      //  PAGE BREAK — start English guide
      // ═══════════════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),

      // ── English ─────────────────────────────────────────────────────────

      h1('AgentsGate Rules & Policy Guide'),
      para('This guide explains how to customize AgentsGate\'s policy rules — the controls that decide which AI agent operations are allowed, blocked, or paused for your review. No programming knowledge required.'),

      // ── 1. How Rules Work ──────────────────────────────────────────────
      h2('1. How Rules Work'),
      para('Every time your AI agent makes a tool call (reading a file, sending an email, querying a database, etc.), AgentsGate evaluates it against two layers of rules:'),
      bullet([bold('Built-in L1 Rules'), normal(' — hardcoded safety rules that always run. You cannot delete them, but you can mute or tune them.')]),
      bullet([bold('Custom Policy Rules'), normal(' — rules you create to fit your specific needs. These run after L1 and can override the score or force a specific action.')]),
      para('Each rule either:'),
      bullet([bold('Sets a risk score'), normal(' (0.0 = safe → 1.0 = dangerous) — the highest score from all matching rules determines the final outcome')]),
      bullet([bold('Forces an action'), normal(' — block, allow, or require_approval, bypassing the threshold calculation')]),
      spacer(),
      tip('Think of L1 rules as a factory alarm system. Your custom rules are the access badges and override keys you hand out to specific people or teams.'),

      // ── 2. The Rules Tab ───────────────────────────────────────────────
      h2('2. The Rules Tab in the Dashboard'),
      para('Open the dashboard (http://localhost:3000) and click the Rules tab. You will see three sections:'),

      h3('Policy Rules table'),
      para('Lists all your custom rules with a Hits column showing how many times each rule has matched a real operation since the proxy started. Rules with 0 hits (shown in faint text) may be dead weight.'),
      spacer(),
      makeTable(
        ['Column', 'What it shows'],
        [
          ['Priority', 'Evaluation order — lower number = checked first'],
          ['ID', 'Unique identifier for the rule'],
          ['Description', 'Your human-readable label'],
          ['Tool', 'Which MCP tool the rule targets'],
          ['Method', 'Which method the rule targets'],
          ['Action', 'block / allow / require_approval'],
          ['Score', 'Custom risk score override (if set)'],
          ['Hits', 'How many real operations matched this rule'],
          ['Actions', 'Edit or Delete buttons'],
        ],
        [1800, 5200]
      ),
      spacer(),

      h3('Built-in L1 Rules section'),
      para('Displays all hardcoded L1 rules — their IDs, default scores, and what triggers them. These cannot be deleted from the dashboard, but you can mute or tune them via the policy file.'),

      h3('Preset Templates'),
      para('Six one-click buttons to create the most common protection rules without writing JSON:'),
      spacer(),
      makeTable(
        ['Preset', 'What it creates'],
        [
          ['Block Filesystem Writes', 'Blocks write / overwrite / create on the filesystem tool'],
          ['Require Approval: Email', 'Approval gate for send / reply / forward on Gmail'],
          ['Require Approval: Slack', 'Approval gate for Slack messages to public channels'],
          ['Read-Only Agent', 'Scores all ops from a named agent at 0.05 (always allowed)'],
          ['Trust Internal Email', 'Auto-allows email ops to your company domain'],
          ['Block Calendar Changes', 'Blocks create / update / delete on Google Calendar'],
        ],
        [2800, 5200]
      ),
      spacer(),
      para('Clicking a preset opens the rule editor pre-filled. Review the details, adjust if needed, then click Save.'),

      // ── 3. Quick-Create from Operation Rows ────────────────────────────
      h2('3. Quick-Create Rules from Operation Rows'),
      para('The fastest way to protect against a suspicious operation is to turn it directly into a rule without leaving the Operations tab.'),

      h3('How to use it'),
      bullet('Go to the Operations tab'),
      bullet('Click any row to expand its detail panel'),
      bullet('Scroll to the Quick rule: bar at the bottom of the detail panel'),
      bullet([bold('Block tool/method'), normal(' — creates a rule that blocks this exact combination')]),
      bullet([bold('Require approval'), normal(' — creates a rule that pauses this operation for your review')], 1),
      bullet([bold('Trust agent agentId'), normal(' — creates an allow rule that always trusts this specific agent')], 1),
      bullet('Each button opens the rule editor pre-filled — adjust and click Save'),
      spacer(),

      h3('Step-by-step example: blocking unexpected Slack messages'),
      bullet('You notice an operation: slack → send_message, which you did not expect your agent to perform'),
      bullet('Click the operation row to expand it'),
      bullet('Click Block slack/send_message in the Quick rule: bar'),
      bullet([normal('The rule editor opens with:\n  '), inlineCode('ID: BLOCK_SLACK_SEND_MESSAGE'), normal('  '), inlineCode('action: block'), normal('  '), inlineCode('tool: slack'), normal('  '), inlineCode('method: send_message')]),
      bullet('Click Save — the rule is immediately active'),
      bullet('Future slack/send_message calls are blocked and logged'),
      spacer(),
      tip('Quick-create buttons are also available for the Block and Approve presets. Use them as starting points, then fine-tune with paramsMatch to narrow the rule to only the specific channel or recipient.'),

      // ── 4. Creating Rules Manually ─────────────────────────────────────
      h2('4. Creating and Editing Rules Manually'),
      para('Click New Rule in the Rules tab to open the rule editor. You can also edit policy.json directly — the file is at:'),
      ...code([
        '~/.agentsgate/policy.json          (macOS / Linux)',
        'C:\\Users\\<name>\\.agentsgate\\policy.json   (Windows)',
      ]),
      spacer(),

      h3('Rule structure'),
      ...code([
        '{',
        '  "id": "MY_RULE_ID",',
        '  "description": "Human-readable label",',
        '  "match": {',
        '    "tool": "slack",',
        '    "method": "send_message"',
        '  },',
        '  "action": "block",',
        '  "priority": 10',
        '}',
      ]),
      spacer(),
      makeTable(
        ['Field', 'Required?', 'Description'],
        [
          ['id',          'Yes', 'Unique identifier. Appears in logs and the Hits table.'],
          ['description', 'No',  'Free-text label shown in the dashboard.'],
          ['match',       'Yes', 'Conditions that must all match (AND logic). See Section 5.'],
          ['action',      'No',  'block, allow, or require_approval. Overrides thresholds.'],
          ['score',       'No',  'Risk score override (0.0–1.0). Used when no action is set.'],
          ['priority',    'No',  'Evaluation order. Default: 100. Lower = evaluated first.'],
          ['redact',      'No',  'List of param keys to replace with [REDACTED] in logs.'],
          ['max',         'No',  'Cap on the score this rule can contribute.'],
        ],
        [1500, 1200, 5300]
      ),
      spacer(),

      // ── 5. Match Criteria ──────────────────────────────────────────────
      h2('5. Match Criteria — Targeting the Right Operations'),
      para([
        normal('Every field inside '),
        inlineCode('"match"'),
        normal(' must match for the rule to fire (AND logic). You can use exact strings or '),
        bold('/regex/flags'),
        normal(' patterns.'),
      ]),
      spacer(),
      makeTable(
        ['Match field', 'What it targets', 'Example value'],
        [
          ['tool',         'MCP tool name',                     '"slack" or "/gmail|outlook/"'],
          ['method',       'Tool method name',                  '"send_message" or "/delete|remove/i"'],
          ['agentId',      'Agent identifier',                  '"my-agent" or "/^prod-.*/"'],
          ['pathPattern',  'params.path or params.filePath',    '"/secrets/" or "/\\.env$/"'],
          ['tags',         'Operation tags (all must match)',    '["production", "sensitive"]'],
          ['paramsMatch',  'Any field inside operation params', '{ "channel": "/^D[A-Z0-9]+/" }'],
        ],
        [1600, 2600, 3800]
      ),
      spacer(),

      h3('5a. Simple exact match'),
      para('Match any call to the slack tool\'s send_message method:'),
      ...code([
        '"match": { "tool": "slack", "method": "send_message" }',
      ]),

      h3('5b. Regex match'),
      para('Match any delete or remove method on any tool (case-insensitive):'),
      ...code([
        '"match": { "method": "/delete|remove/i" }',
      ]),

      h3('5c. Match by agent'),
      para('Match all operations from agents whose ID starts with "prod-":'),
      ...code([
        '"match": { "agentId": "/^prod-/" }',
      ]),

      h3('5d. Match by file path (paramsMatch)'),
      para([
        normal('Use '),
        inlineCode('paramsMatch'),
        normal(' to inspect individual fields inside the operation\'s params object. This is how you distinguish a Slack DM from a channel message, or an internal email from an external one.'),
      ]),
      para('Match only Slack direct messages (DM channel IDs start with "D"):'),
      ...code([
        '"match": {',
        '  "tool": "slack",',
        '  "method": "send_message",',
        '  "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }',
        '}',
      ]),

      // ── 6. Full Example Rules ──────────────────────────────────────────
      h2('6. Full Example Rules'),

      h3('Example A — Block all Slack messages'),
      para([bold('Goal: '), normal('Prevent the AI agent from ever sending Slack messages without your explicit approval.')]),
      ...code([
        '{',
        '  "id": "BLOCK_ALL_SLACK_SEND",',
        '  "description": "Block agent from sending any Slack message",',
        '  "match": { "tool": "slack", "method": "/send|post|reply/i" },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('Example B — Require approval for Slack DMs only'),
      para([bold('Goal: '), normal('Allow the agent to post to public channels freely, but require your approval for direct messages.')]),
      ...code([
        '{',
        '  "id": "APPROVE_SLACK_DM",',
        '  "description": "Require approval for Slack direct messages",',
        '  "match": {',
        '    "tool": "slack",',
        '    "method": "send_message",',
        '    "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }',
        '  },',
        '  "action": "require_approval",',
        '  "priority": 5',
        '}',
      ]),

      h3('Example C — Block external email recipients'),
      para([bold('Goal: '), normal('Prevent the agent from emailing anyone outside your company domain.')]),
      ...code([
        '{',
        '  "id": "BLOCK_EXTERNAL_EMAIL",',
        '  "description": "Block outbound email to non-company addresses",',
        '  "match": {',
        '    "tool": "gmail",',
        '    "method": "/send|reply|forward/i",',
        '    "paramsMatch": {',
        '      "to": "/^(?!.*@mycompany\\.com).*$/"',
        '    }',
        '  },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('Example D — Block deletes on the production calendar'),
      para([bold('Goal: '), normal('Protect a specific Google Calendar from deletion.')]),
      ...code([
        '{',
        '  "id": "BLOCK_PROD_CALENDAR_DELETE",',
        '  "description": "Block event deletions on the production calendar",',
        '  "match": {',
        '    "tool": "google-calendar",',
        '    "method": "delete_event",',
        '    "paramsMatch": { "calendarId": "production@mycompany.com" }',
        '  },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('Example E — Trust a read-only agent'),
      para([bold('Goal: '), normal('Give a reporting agent a low risk score so it never triggers approval prompts.')]),
      ...code([
        '{',
        '  "id": "TRUST_READONLY_AGENT",',
        '  "description": "Always allow the reporting agent",',
        '  "match": { "agentId": "reporting-agent" },',
        '  "score": 0.05,',
        '  "priority": 1',
        '}',
      ]),

      h3('Example F — Elevate risk for writes to sensitive paths'),
      para([bold('Goal: '), normal('Any write to a path containing /secrets/ or /.env should trigger an approval regardless of the default threshold.')]),
      ...code([
        '{',
        '  "id": "ELEVATE_SECRETS_WRITE",',
        '  "description": "Treat writes to secret paths as high risk",',
        '  "match": {',
        '    "tool": "filesystem",',
        '    "method": "/write|create|overwrite/i",',
        '    "pathPattern": "/secrets/|/\\.env"',
        '  },',
        '  "score": 0.90,',
        '  "priority": 10',
        '}',
      ]),

      // ── 7. Built-in L1 Rules ───────────────────────────────────────────
      h2('7. Built-in L1 Rules Reference'),
      para([normal('These rules always run. To suppress a rule, add its ID to '), inlineCode('"mutedRules"'), normal('. To change its score, use '), inlineCode('"ruleOverrides"'), normal('.')]),

      h3('Filesystem & System'),
      makeTable(
        ['Rule ID', 'Triggered by', 'Score'],
        [
          ['L1_DELETE_FILE',         'delete_file, unlink, rm',                          '0.90'],
          ['L1_SENSITIVE_PATH_WRITE','Writes to .env, .ssh/, .aws/, credentials',        '0.90'],
          ['L1_DROP_TABLE',          'drop, truncate on database tools',                  '0.95'],
          ['L1_DELETE_RECORD',       'delete, remove on non-filesystem tools',             '0.75'],
          ['L1_EXECUTE_COMMAND',     'execute, exec, shell, spawn',                       '0.80'],
          ['L1_GIT_FORCE_PUSH',      'force, reset, rebase on git tools',                 '0.85'],
          ['L1_OVERWRITE_FILE',      'write_file, overwrite, create on filesystem',       '0.65'],
          ['L1_READ_ONLY',           'read_*, list_*, get_*, describe_*',                '0.05'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Slack'),
      makeTable(
        ['Rule ID', 'Triggered by', 'Score'],
        [
          ['L1_SLACK_SEND',   'send_message, post_message, reply on slack',          '0.70'],
          ['L1_SLACK_DELETE', 'delete_message, delete, remove on slack',             '0.80'],
          ['L1_SLACK_READ',   'list_*, get_*, read_*, search_*, history on slack',   '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Gmail'),
      makeTable(
        ['Rule ID', 'Triggered by', 'Score'],
        [
          ['L1_GMAIL_SEND',   'send, reply, forward on gmail',                       '0.90'],
          ['L1_GMAIL_DRAFT',  'draft, create, compose (non-send) on gmail',          '0.30'],
          ['L1_GMAIL_DELETE', 'delete, trash, remove on gmail',                      '0.80'],
          ['L1_GMAIL_READ',   'list_*, get_*, read_*, search_* on gmail',            '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Google Calendar'),
      makeTable(
        ['Rule ID', 'Triggered by', 'Score'],
        [
          ['L1_GCAL_CREATE',  'create_event, insert, add on google-calendar',       '0.40'],
          ['L1_GCAL_UPDATE',  'update_event, patch, modify on google-calendar',     '0.50'],
          ['L1_GCAL_DELETE',  'delete_event, remove on google-calendar',            '0.75'],
          ['L1_GCAL_READ',    'list_*, get_*, read_*, search_* on google-calendar', '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      // ── 8. Adjusting Thresholds ────────────────────────────────────────
      h2('8. Adjusting Risk Thresholds'),
      para('The three intervention zones are controlled by two thresholds in your policy file:'),
      ...code([
        '{',
        '  "thresholds": {',
        '    "allowBelow": 0.30,',
        '    "blockAtOrAbove": 0.70',
        '  }',
        '}',
      ]),
      spacer(),
      makeTable(
        ['Score range', 'Default action', 'Change to...'],
        [
          ['0.00 – 0.29', 'Allowed automatically',              'Raise allowBelow to be more strict'],
          ['0.30 – 0.69', 'Paused — requires your approval',   'Narrow this band to reduce interruptions'],
          ['0.70 – 1.00', 'Blocked outright',                   'Lower blockAtOrAbove to block earlier'],
        ],
        [1800, 3000, 3200]
      ),
      spacer(),
      tip('Start with the defaults. After a few days in dry-run mode (agentsgate start --dry-run) you will see the actual score distribution for your agents and can tune from there.'),

      // ── 9. Muting and Overriding L1 Rules ─────────────────────────────
      h2('9. Muting and Overriding Built-in Rules'),

      h3('Mute a rule (suppress false positives)'),
      ...code([
        '{',
        '  "mutedRules": ["L1_OVERWRITE_FILE"]',
        '}',
      ]),

      h3('Override a rule\'s score'),
      ...code([
        '{',
        '  "ruleOverrides": {',
        '    "L1_DELETE_FILE": 0.50,',
        '    "L1_SLACK_SEND": 0.30',
        '  }',
        '}',
      ]),
      para([normal('The rule still fires and is logged — it just uses your score instead of the built-in one. Run '), inlineCode('agentsgate policy list'), normal(' to see all active rule IDs.')]),

      // ── 10. Troubleshooting ────────────────────────────────────────────
      h2('10. Quick Troubleshooting'),
      makeTable(
        ['Problem', 'Likely cause', 'Fix'],
        [
          ['Rule never fires (0 Hits)',    'match field is wrong',                 'Use the Rule Tester in the dashboard Rules tab to test against a real operation'],
          ['Too many approval prompts',    'threshold too low or broad rule',      'Raise allowBelow, or narrow the rule\'s match criteria'],
          ['Legitimate op is blocked',     'L1 rule over-triggering',              'Add a custom rule with action: allow at priority 1, or mute the L1 rule'],
          ['Rule fires on wrong operation','regex too broad',                       'Tighten the regex or add more match fields'],
          ['Changes not taking effect',    'policy.json not saved / wrong path',   'Check the path shown on the dashboard Rules tab header'],
        ],
        [1800, 2400, 3800]
      ),
      spacer(),

      // ═══════════════════════════════════════════════════════════════════════
      //  PAGE BREAK — start Japanese guide
      // ═══════════════════════════════════════════════════════════════════════
      new Paragraph({ children: [new PageBreak()] }),

      // ── Japanese ────────────────────────────────────────────────────────

      h1('AgentsGate ルール＆ポリシー 入門ガイド'),
      para('このガイドでは、AgentsGateのポリシールールのカスタマイズ方法を説明します。AIエージェントの操作を許可・ブロック・承認待ちにする仕組みを、プログラミング知識なしで設定できます。'),

      // ── 1 ─────────────────────────────────────────────────────────────
      h2('1. ルールの仕組み'),
      para('AIエージェントがツール呼び出し（ファイルの読み取り、メール送信、データベース問い合わせなど）を行うたびに、AgentsGateは2つのレイヤーのルールで評価します：'),
      bullet([bold('組み込みL1ルール'), normal(' — 常時実行されるハードコードされた安全ルール。削除はできませんが、ミュートやスコア調整は可能です。')]),
      bullet([bold('カスタムポリシールール'), normal(' — あなたが作成するルール。L1の後で実行され、スコアを上書きしたりアクションを強制したりできます。')]),
      para('各ルールは次のどちらかを行います：'),
      bullet([bold('リスクスコアを設定する'), normal(' （0.0 = 安全 → 1.0 = 危険）— すべての一致ルールの中で最も高いスコアが最終結果を決定します')]),
      bullet([bold('アクションを強制する'), normal(' — block（ブロック）、allow（許可）、require_approval（承認必須）。しきい値計算をバイパスします')]),
      spacer(),
      tip('L1ルールを工場の警報システムと考えてください。カスタムルールは特定の人やチームに渡すアクセスバッジと上書きキーです。'),

      // ── 2 ─────────────────────────────────────────────────────────────
      h2('2. ダッシュボードのRulesタブ'),
      para('ダッシュボード（http://localhost:3000）を開き、Rulesタブをクリックします。3つのセクションが表示されます：'),

      h3('ポリシールール表'),
      para('すべてのカスタムルールがHits（ヒット数）列付きで一覧表示されます。ヒット数が0（薄いテキスト）のルールは不要な可能性があります。'),
      spacer(),
      makeTable(
        ['列', '表示内容'],
        [
          ['Priority', '評価順序 — 数値が低いほど先に評価'],
          ['ID', 'ルールの一意の識別子'],
          ['Description', 'あなたが設定した説明文'],
          ['Tool', 'ルールが対象とするMCPツール'],
          ['Method', 'ルールが対象とするメソッド'],
          ['Action', 'block / allow / require_approval'],
          ['Score', 'カスタムリスクスコアの上書き（設定時）'],
          ['Hits', 'このルールが実際に発火した回数'],
          ['Actions', '編集・削除ボタン'],
        ],
        [1800, 5200]
      ),
      spacer(),

      h3('組み込みL1ルールセクション'),
      para('すべてのハードコードされたL1ルール（ID、デフォルトスコア、説明）を表示します。ダッシュボードから削除はできませんが、ポリシーファイルでミュートまたはスコア上書きが可能です。'),

      h3('プリセットテンプレート'),
      para('JSONを書かずに一般的な保護ルールを作成できる6つのワンクリックボタン：'),
      spacer(),
      makeTable(
        ['プリセット', '作成されるルール'],
        [
          ['ファイルシステム書き込みをブロック', 'filesystemツールでのwrite / overwrite / create操作をすべてブロック'],
          ['承認必須：メール', 'GmailのSend / Reply / Forward操作に承認を要求'],
          ['承認必須：Slack', 'Slackの公開チャンネルへのメッセージ送信に承認を要求'],
          ['読み取り専用エージェント', '指定エージェントのすべての操作を0.05スコア（常時許可）に設定'],
          ['社内メールを信頼', '社内ドメイン宛メール操作を自動許可'],
          ['カレンダー変更をブロック', 'Google Calendarの作成/更新/削除をブロック'],
        ],
        [2800, 5200]
      ),
      spacer(),
      para('プリセットをクリックするとルールエディタが事前入力された状態で開きます。内容を確認して必要に応じて調整し、Saveをクリックします。'),

      // ── 3 ─────────────────────────────────────────────────────────────
      h2('3. 操作行からのクイックルール作成'),
      para('疑わしい操作を発見したとき、Operationsタブを離れずにそのままルールに変換できます。'),

      h3('使い方'),
      bullet('Operationsタブを開く'),
      bullet('任意の行をクリックして詳細パネルを展開する'),
      bullet('詳細パネル下部のQuick rule:バーまでスクロールする'),
      bullet([bold('Block ツール/メソッド'), normal(' — この特定の組み合わせをブロックするルールを作成')]),
      bullet([bold('Require approval'), normal(' — この操作を承認待ちにするルールを作成')], 1),
      bullet([bold('Trust agent agentId'), normal(' — この特定エージェントを常に信頼するallowルールを作成')], 1),
      bullet('各ボタンはルールエディタを事前入力済みの状態で開きます — 調整してSaveをクリック'),
      spacer(),

      h3('例：予期しないSlackメッセージをブロックする'),
      bullet([normal('slack → send_messageという操作を発見 — エージェントがSlackメッセージを送信しているとは思っていなかった')]),
      bullet('操作行をクリックして詳細パネルを展開する'),
      bullet('Quick rule:バーの「Block slack/send_message」をクリック'),
      bullet([normal('ルールエディタが'), inlineCode('ID: BLOCK_SLACK_SEND_MESSAGE'), normal('、'), inlineCode('action: block'), normal('、'), inlineCode('tool: slack'), normal('、'), inlineCode('method: send_message'), normal(' で事前入力された状態で開く')]),
      bullet('必要に応じて説明を調整し、Saveをクリック'),
      bullet('ルールは即座に有効になります — 以降のslack/send_message呼び出しはブロックされます'),
      spacer(),
      tip('クイック作成したルールはparamsMatchでさらに絞り込めます。例えば「特定チャンネルへの送信だけをブロック」「特定宛先へのメールだけを承認必須にする」などの細かな制御が可能です。'),

      // ── 4 ─────────────────────────────────────────────────────────────
      h2('4. ルールの手動作成と編集'),
      para('RulesタブのNew Ruleをクリックしてルールエディタを開きます。policy.jsonを直接編集することもできます — ファイルの場所：'),
      ...code([
        '~/.agentsgate/policy.json                    (macOS / Linux)',
        'C:\\Users\\<名前>\\.agentsgate\\policy.json   (Windows)',
      ]),
      spacer(),

      h3('ルールの構造'),
      ...code([
        '{',
        '  "id": "MY_RULE_ID",',
        '  "description": "説明文",',
        '  "match": {',
        '    "tool": "slack",',
        '    "method": "send_message"',
        '  },',
        '  "action": "block",',
        '  "priority": 10',
        '}',
      ]),
      spacer(),
      makeTable(
        ['フィールド', '必須?', '説明'],
        [
          ['id',          '必須', '一意の識別子。ログとHits表に表示されます。'],
          ['description', '任意', 'ダッシュボードに表示される自由記述のラベル。'],
          ['match',       '必須', '一致条件（AND論理）。セクション5を参照。'],
          ['action',      '任意', 'block、allow、またはrequire_approval。しきい値をバイパス。'],
          ['score',       '任意', 'リスクスコアの上書き（0.0〜1.0）。actionが未設定の場合に使用。'],
          ['priority',    '任意', '評価順序。デフォルト: 100。低い数値ほど先に評価。'],
          ['redact',      '任意', 'ログで[REDACTED]に置き換えるパラメータキーのリスト。'],
          ['max',         '任意', 'このルールが貢献できるスコアの上限。'],
        ],
        [1500, 900, 5600]
      ),
      spacer(),

      // ── 5 ─────────────────────────────────────────────────────────────
      h2('5. マッチ条件 — 正しい操作を対象にする'),
      para([
        inlineCode('"match"'),
        normal(' 内のすべてのフィールドが一致した場合にルールが発火します（AND論理）。完全一致文字列または '),
        bold('/regex/flags'),
        normal(' パターンを使用できます。'),
      ]),
      spacer(),
      makeTable(
        ['マッチフィールド', '対象', '例'],
        [
          ['tool',         'MCPツール名',                   '"slack" または "/gmail|outlook/"'],
          ['method',       'ツールメソッド名',               '"send_message" または "/delete|remove/i"'],
          ['agentId',      'エージェント識別子',             '"my-agent" または "/^prod-.*/"'],
          ['pathPattern',  'params.pathまたはfilePath',     '"/secrets/" または "/\\.env$/"'],
          ['tags',         '操作タグ（全て一致必須）',       '["production", "sensitive"]'],
          ['paramsMatch',  '操作パラメータ内の任意フィールド', '{ "channel": "/^D[A-Z0-9]+/" }'],
        ],
        [1800, 2400, 3800]
      ),
      spacer(),

      h3('5a. シンプルな完全一致'),
      para('slackツールのsend_messageメソッドへのすべての呼び出しに一致：'),
      ...code([
        '"match": { "tool": "slack", "method": "send_message" }',
      ]),

      h3('5b. 正規表現での一致'),
      para('どのツールでもdeleteまたはremoveメソッドに一致（大文字小文字を区別しない）：'),
      ...code([
        '"match": { "method": "/delete|remove/i" }',
      ]),

      h3('5c. エージェントIDでの一致'),
      para('"prod-"で始まるIDのエージェントからのすべての操作に一致：'),
      ...code([
        '"match": { "agentId": "/^prod-/" }',
      ]),

      h3('5d. パラメータ値での一致（paramsMatch）'),
      para([
        inlineCode('paramsMatch'),
        normal(' を使うと、操作のparamsオブジェクト内の特定フィールドを検査できます。SlackのDMとチャンネルメッセージの区別、社内メールと社外メールの区別などに使います。'),
      ]),
      para('SlackダイレクトメッセージのみマッチさせるRule（DMのチャンネルIDは"D"で始まる）：'),
      ...code([
        '"match": {',
        '  "tool": "slack",',
        '  "method": "send_message",',
        '  "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }',
        '}',
      ]),

      // ── 6 ─────────────────────────────────────────────────────────────
      h2('6. ルールの完全なサンプル集'),

      h3('サンプルA — Slackメッセージを全てブロック'),
      para([bold('目的：'), normal('AIエージェントが承認なしにSlackメッセージを送信できないようにする。')]),
      ...code([
        '{',
        '  "id": "BLOCK_ALL_SLACK_SEND",',
        '  "description": "エージェントのSlackメッセージ送信を全てブロック",',
        '  "match": { "tool": "slack", "method": "/send|post|reply/i" },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('サンプルB — SlackダイレクトメッセージのみApproval'),
      para([bold('目的：'), normal('公開チャンネルへの投稿は自由に許可するが、ダイレクトメッセージは承認を要求する。')]),
      ...code([
        '{',
        '  "id": "APPROVE_SLACK_DM",',
        '  "description": "SlackダイレクトメッセージにApprovalを要求",',
        '  "match": {',
        '    "tool": "slack",',
        '    "method": "send_message",',
        '    "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }',
        '  },',
        '  "action": "require_approval",',
        '  "priority": 5',
        '}',
      ]),

      h3('サンプルC — 社外宛メールのブロック'),
      para([bold('目的：'), normal('社外のアドレス宛にメールを送れないようにする。')]),
      ...code([
        '{',
        '  "id": "BLOCK_EXTERNAL_EMAIL",',
        '  "description": "社外宛メール送信をブロック",',
        '  "match": {',
        '    "tool": "gmail",',
        '    "method": "/send|reply|forward/i",',
        '    "paramsMatch": {',
        '      "to": "/^(?!.*@mycompany\\.com).*$/"',
        '    }',
        '  },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('サンプルD — 本番カレンダーのイベント削除をブロック'),
      para([bold('目的：'), normal('特定のGoogle Calendarをイベント削除から保護する。')]),
      ...code([
        '{',
        '  "id": "BLOCK_PROD_CALENDAR_DELETE",',
        '  "description": "本番カレンダーのイベント削除をブロック",',
        '  "match": {',
        '    "tool": "google-calendar",',
        '    "method": "delete_event",',
        '    "paramsMatch": { "calendarId": "production@mycompany.com" }',
        '  },',
        '  "action": "block",',
        '  "priority": 5',
        '}',
      ]),

      h3('サンプルE — 読み取り専用エージェントを信頼する'),
      para([bold('目的：'), normal('レポート用エージェントに低リスクスコアを設定し、承認プロンプトが発生しないようにする。')]),
      ...code([
        '{',
        '  "id": "TRUST_READONLY_AGENT",',
        '  "description": "レポートエージェントを常時許可",',
        '  "match": { "agentId": "reporting-agent" },',
        '  "score": 0.05,',
        '  "priority": 1',
        '}',
      ]),

      h3('サンプルF — 機密パスへの書き込みをリスク上昇'),
      para([bold('目的：'), normal('/secrets/や.envを含むパスへの書き込みは、デフォルトのしきい値に関わらず承認を必要とする。')]),
      ...code([
        '{',
        '  "id": "ELEVATE_SECRETS_WRITE",',
        '  "description": "機密パスへの書き込みを高リスクとして扱う",',
        '  "match": {',
        '    "tool": "filesystem",',
        '    "method": "/write|create|overwrite/i",',
        '    "pathPattern": "/secrets/|/\\.env"',
        '  },',
        '  "score": 0.90,',
        '  "priority": 10',
        '}',
      ]),

      // ── 7 ─────────────────────────────────────────────────────────────
      h2('7. 組み込みL1ルール一覧'),
      para([normal('これらのルールは常時実行されます。ルールを抑制するには'), inlineCode('"mutedRules"'), normal('にIDを追加します。スコアを変更するには'), inlineCode('"ruleOverrides"'), normal('を使います。')]),

      h3('ファイルシステム＆システム'),
      makeTable(
        ['ルールID', 'トリガー条件', 'スコア'],
        [
          ['L1_DELETE_FILE',         'delete_file、unlink、rm',                         '0.90'],
          ['L1_SENSITIVE_PATH_WRITE','.env、.ssh/、.aws/、credentialsへの書き込み',      '0.90'],
          ['L1_DROP_TABLE',          'データベースツールでのdrop、truncate',               '0.95'],
          ['L1_DELETE_RECORD',       '非ファイルシステムツールでのdelete、remove',         '0.75'],
          ['L1_EXECUTE_COMMAND',     'execute、exec、shell、spawn',                      '0.80'],
          ['L1_GIT_FORCE_PUSH',      'gitツールでのforce、reset、rebase',                 '0.85'],
          ['L1_OVERWRITE_FILE',      'ファイルシステムでのwrite_file、overwrite、create', '0.65'],
          ['L1_READ_ONLY',           'read_*、list_*、get_*、describe_*',               '0.05'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Slack'),
      makeTable(
        ['ルールID', 'トリガー条件', 'スコア'],
        [
          ['L1_SLACK_SEND',   'slackツールでのsend_message、post_message、reply',  '0.70'],
          ['L1_SLACK_DELETE', 'slackツールでのdelete_message、delete、remove',     '0.80'],
          ['L1_SLACK_READ',   'slackツールでのlist_*、get_*、read_*、history',     '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Gmail'),
      makeTable(
        ['ルールID', 'トリガー条件', 'スコア'],
        [
          ['L1_GMAIL_SEND',   'gmailツールでのsend、reply、forward',              '0.90'],
          ['L1_GMAIL_DRAFT',  'gmailツールでのdraft、create、compose（送信以外）', '0.30'],
          ['L1_GMAIL_DELETE', 'gmailツールでのdelete、trash、remove',             '0.80'],
          ['L1_GMAIL_READ',   'gmailツールでのlist_*、get_*、read_*、search_*',   '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      h3('Google Calendar'),
      makeTable(
        ['ルールID', 'トリガー条件', 'スコア'],
        [
          ['L1_GCAL_CREATE', 'google-calendarツールでのcreate_event、insert、add',    '0.40'],
          ['L1_GCAL_UPDATE', 'google-calendarツールでのupdate_event、patch、modify',  '0.50'],
          ['L1_GCAL_DELETE', 'google-calendarツールでのdelete_event、remove',         '0.75'],
          ['L1_GCAL_READ',   'google-calendarツールでのlist_*、get_*、search_*',      '0.10'],
        ],
        [2400, 4800, 900]
      ),
      spacer(),

      // ── 8 ─────────────────────────────────────────────────────────────
      h2('8. リスクしきい値の調整'),
      para('3つの介入ゾーンはポリシーファイルの2つのしきい値で制御されます：'),
      ...code([
        '{',
        '  "thresholds": {',
        '    "allowBelow": 0.30,',
        '    "blockAtOrAbove": 0.70',
        '  }',
        '}',
      ]),
      spacer(),
      makeTable(
        ['スコア範囲', 'デフォルトのアクション', '調整方法'],
        [
          ['0.00 – 0.29', '自動的に許可',            'より厳格にしたい場合はallowBelowを下げる'],
          ['0.30 – 0.69', '一時停止 — 承認を要求',   '中断を減らしたい場合はこの範囲を狭める'],
          ['0.70 – 1.00', '完全にブロック',           '早めにブロックしたい場合はblockAtOrAboveを下げる'],
        ],
        [1800, 2800, 3400]
      ),
      spacer(),
      tip('最初はデフォルト値のままにしてください。agentsgate start --dry-runでドライランモードを数日間実行すると、エージェントの実際のスコア分布を確認でき、そこから調整できます。'),

      // ── 9 ─────────────────────────────────────────────────────────────
      h2('9. 組み込みルールのミュートとスコア上書き'),

      h3('ルールのミュート（誤検知の抑制）'),
      ...code([
        '{',
        '  "mutedRules": ["L1_OVERWRITE_FILE"]',
        '}',
      ]),

      h3('ルールのスコアを上書き'),
      ...code([
        '{',
        '  "ruleOverrides": {',
        '    "L1_DELETE_FILE": 0.50,',
        '    "L1_SLACK_SEND": 0.30',
        '  }',
        '}',
      ]),
      para([normal('ルールは引き続き発火・記録されます — 組み込みのスコアの代わりにあなたのスコアが使われます。'), inlineCode('agentsgate policy list'), normal('でアクティブなルールIDを確認できます。')]),

      // ── 10 ────────────────────────────────────────────────────────────
      h2('10. よくある問題と対処法'),
      makeTable(
        ['問題', '考えられる原因', '対処法'],
        [
          ['ルールが全く発火しない（Hits = 0）', 'matchフィールドが間違っている',      'ダッシュボードRulesタブのRule Testerで実際の操作に対してテストする'],
          ['承認プロンプトが多すぎる',           'しきい値が低すぎる、またはルールが広すぎる', 'allowBelowを上げるか、ルールのmatch条件を絞り込む'],
          ['正当な操作がブロックされる',         'L1ルールが過剰反応している',          'priority 1でaction: allowのカスタムルールを追加するか、L1ルールをミュートする'],
          ['ルールが想定外の操作に発火する',     '正規表現が広すぎる',                  '正規表現を厳しくするか、matchフィールドを追加する'],
          ['変更が反映されない',                'policy.jsonが保存されていない/パスが違う', 'ダッシュボードRulesタブのヘッダーに表示されているパスを確認する'],
        ],
        [1800, 2600, 3600]
      ),
      spacer(200),
    ],
  }],
});

const buffer = await Packer.toBuffer(doc);
writeFileSync(OUT, buffer);
console.log('Written:', OUT);
