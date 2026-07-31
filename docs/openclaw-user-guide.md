# AgentsGate for OpenClaw Users
# OpenClawユーザー向け AgentsGate ガイド

---

## Table of Contents / 目次

- [English Guide](#english-guide)
- [日本語ガイド](#日本語ガイド)

---

# English Guide

## Why OpenClaw Users Need AgentsGate

OpenClaw is a powerful autonomous AI agent. It can control your filesystem, run shell commands, browse the web, send messages, and call hundreds of external APIs — all without asking for your permission first. This makes it fast and productive, but it also means:

- A misunderstood instruction can delete the wrong files
- An AI hallucination can run a destructive shell command
- A compromised MCP server can silently exfiltrate data
- There is no audit trail of what the agent did or why

**AgentsGate fills this gap.** It acts as a transparent proxy between OpenClaw and every MCP tool it calls. Every tool call is intercepted, risk-scored, logged, and — if dangerous — paused for your approval or blocked outright. If something goes wrong, you can roll back to a snapshot taken just before the damage occurred.

```
OpenClaw Agent
      ↓  MCP (stdio)
┌─────────────────────┐
│  AgentsGate Proxy  │  ← Intercepts every tool call
└──────┬──────────────┘
       │  risk-scores, logs, checkpoints
       ↓
  ┌────┴────┐  ┌──────────────┐  ┌────────────────┐
  │filesystem│  │browser/web  │  │shell / exec    │
  │  server  │  │  server     │  │  server        │
  └──────────┘  └─────────────┘  └────────────────┘
```

---

## Prerequisites

- **AgentsGate** installed: `npm install -g agentsgate`
- **OpenClaw** installed and working: `openclaw --version`
- OpenClaw's config file at `~/.openclaw/openclaw.json`

If you haven't installed AgentsGate yet, see [docs/installation-guide.md](installation-guide.md).

---

## Step 1 — Start AgentsGate

Before launching OpenClaw, start AgentsGate:

```bash
agentsgate start
```

This starts:
- **Proxy** on port `4000` — intercepts MCP tool calls
- **Dashboard** on port `4001` — `http://localhost:4001`

Leave this terminal open. AgentsGate must stay running while you use OpenClaw.

---

## Step 2 — Wrap OpenClaw's MCP Servers with AgentsGate

OpenClaw communicates with MCP servers using the `stdio` transport — it launches each server as a child process. AgentsGate wraps each server command so that all traffic passes through the proxy.

### How it works

Instead of OpenClaw talking directly to an MCP server:

```
OpenClaw  →  mcp-filesystem  (direct, unguarded)
```

You configure OpenClaw to launch AgentsGate's stdio proxy, which then launches the real server:

```
OpenClaw  →  agentsgate proxy  →  mcp-filesystem  (guarded)
```

### Edit `~/.openclaw/openclaw.json`

Open your OpenClaw configuration file. Find the `mcpServers` section and wrap each server with `agentsgate proxy`.

#### Before (unprotected)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "mcp-filesystem",
      "args": ["--root", "/home/user/projects"]
    },
    "browser": {
      "command": "mcp-browser",
      "args": []
    },
    "shell": {
      "command": "mcp-shell",
      "args": ["--allow", "/home/user"]
    }
  }
}
```

#### After (protected by AgentsGate)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-filesystem",
        "--args", "--root,/home/user/projects",
        "--agentId", "openclaw",
        "--tool", "filesystem"
      ]
    },
    "browser": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-browser",
        "--agentId", "openclaw",
        "--tool", "browser"
      ]
    },
    "shell": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-shell",
        "--args", "--allow,/home/user",
        "--agentId", "openclaw",
        "--tool", "shell"
      ]
    }
  }
}
```

**Key parameters:**
| Parameter | Description |
|-----------|-------------|
| `proxy stdio` | Use AgentsGate's stdio proxy mode |
| `--cmd` | The original MCP server command |
| `--args` | Original arguments, comma-separated |
| `--agentId` | Label for this agent in the dashboard (e.g. `openclaw`) |
| `--tool` | Tool name shown in dashboard and used in policy rules |

After saving the file, OpenClaw hot-reloads the config automatically. The next time OpenClaw calls a tool, it will flow through AgentsGate.

---

## Step 3 — Verify the Connection

Run `openclaw doctor` to confirm MCP servers are accessible:

```bash
openclaw doctor
```

Then open the AgentsGate dashboard at `http://localhost:4001` and ask OpenClaw to do something simple (e.g., list files in a directory). You should immediately see the operation appear in the operation list on the **Overview** tab.

---

## Step 4 — Set an OpenClaw-Specific Policy

Because OpenClaw can execute shell commands, browse the web, and write files autonomously, we recommend a stricter-than-default policy.

Create `~/.agentsgate/policy.json`:

```json
{
  "thresholds": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.65
  },
  "rules": [
    {
      "id": "BLOCK_SHELL_DANGEROUS_CMDS",
      "description": "Block shell commands known to cause irreversible damage",
      "match": {
        "tool": "shell",
        "method": "/exec|run|spawn|shell/"
      },
      "action": "require_approval",
      "priority": 5
    },
    {
      "id": "BLOCK_HOME_DIR_DELETES",
      "description": "Block any deletion in the home directory",
      "match": {
        "tool": "filesystem",
        "method": "/delete|rm|unlink/",
        "pathPattern": "^/home/"
      },
      "action": "block",
      "priority": 1
    },
    {
      "id": "PROTECT_DOTFILES",
      "description": "Require approval before writing to hidden config files",
      "match": {
        "tool": "filesystem",
        "pathPattern": "/\\.[a-zA-Z]"
      },
      "action": "require_approval",
      "priority": 2
    },
    {
      "id": "PROTECT_CREDENTIALS",
      "description": "Block access to credential and secret files",
      "match": {
        "pathPattern": "(\\.env|\\.ssh|\\.aws|credentials|secrets|api.key)"
      },
      "action": "block",
      "priority": 1
    },
    {
      "id": "REQUIRE_APPROVAL_WEB_POST",
      "description": "Require approval before OpenClaw POSTs data to external URLs",
      "match": {
        "tool": "browser",
        "method": "/post|submit|send|upload/"
      },
      "action": "require_approval",
      "priority": 10
    },
    {
      "id": "REDACT_SENSITIVE_PARAMS",
      "description": "Redact API keys and passwords from audit logs",
      "match": { "agentId": "openclaw" },
      "redact": ["apiKey", "api_key", "password", "secret", "token", "authorization"],
      "priority": 100
    }
  ],
  "agents": {
    "toolRules": {
      "openclaw": {
        "allowlist": ["filesystem", "browser", "shell", "web_search", "web_fetch"]
      }
    }
  },
  "ruleOverrides": {
    "L1_EXECUTE_COMMAND": 0.85,
    "L1_DELETE_FILE": 0.95
  }
}
```

Reload the policy without restarting:

```bash
agentsgate config reload
```

---

## Step 5 — Enable Slack Notifications (recommended)

When OpenClaw triggers an approval or gets blocked, get an instant Slack alert:

```json
{
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"
  }
}
```

Add this to `~/.agentsgate/config.json`. Now you'll receive a Slack message whenever OpenClaw attempts something risky — even when you're away from your desk.

---

## Day-to-Day Workflow

### Watching OpenClaw work in real time

Keep the dashboard open at `http://localhost:4001` while OpenClaw runs. The operation list on the **Overview** tab shows a live feed of every tool call, its risk score, and the decision.

Color coding in the dashboard:
- 🟢 **Green** — allowed (score < 0.20 with recommended policy)
- 🟡 **Yellow** — requires your approval (score 0.20–0.64)
- 🔴 **Red** — blocked (score ≥ 0.65)

### Approving a paused operation

When OpenClaw hits a risky step, it pauses and waits. The dashboard shows the pending approval in the **Approvals** tab.

1. Open `http://localhost:4001` → **Overview** tab, pending-approval list
2. Click the pending operation
3. Review: what tool, what method, what file path or command
4. Click **Approve** (OpenClaw continues) or **Deny** (OpenClaw receives an error)

From the CLI:

```bash
agentsgate approvals
agentsgate approvals approve <id>
agentsgate approvals deny <id>
```

### Rolling back after a mistake

If OpenClaw did something unwanted, find the checkpoint taken just before:

```bash
# List checkpoints with timestamps
agentsgate checkpoints

# Preview what would be restored (safe — no changes made)
agentsgate rollback <checkpoint-id> --preview

# Restore files
agentsgate rollback <checkpoint-id>
```

Or use the **Checkpoints** tab in the dashboard.

---

## Using Dry-Run Mode for New Tasks

When giving OpenClaw a new, complex, or unfamiliar task, start in dry-run mode to see what it would do before any enforcement:

```bash
# Stop current AgentsGate and restart in dry-run mode
agentsgate stop
agentsgate start --dry-run
```

In dry-run mode, OpenClaw operates freely but every action is logged with its *would-have-been* decision. Review the dashboard after the task completes, then tighten your policy based on what you see. Restart in normal mode when ready:

```bash
agentsgate stop
agentsgate start
```

---

## Reviewing OpenClaw's Activity

### View the full audit log

```bash
agentsgate audit --agentId=openclaw
```

### See only blocked operations

```bash
agentsgate audit --agentId=openclaw --action=block
```

### Export for review

```bash
agentsgate ops export --format=json --out=openclaw-session.json
```

### Generate a risk summary

```bash
agentsgate report
```

---

## Recommended Configuration for OpenClaw

### `~/.agentsgate/config.json`

```json
{
  "proxy": {
    "port": 4000,
    "checkpointThreshold": 0.20
  },
  "intervention": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.65
  },
  "approvals": {
    "maxAgeMs": 3600000,
    "escalateAfterMs": 600000
  },
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/..."
  },
  "rateLimit": {
    "enabled": true,
    "maxOpsPerMinute": 60
  },
  "dashboard": {
    "apiKey": "your-strong-random-key"
  },
  "audit": {
    "signingSecret": "your-strong-hmac-secret"
  }
}
```

**Notable settings for OpenClaw:**
- `checkpointThreshold: 0.20` — snapshot files before even medium-risk operations
- `maxAgeMs: 3600000` — approvals expire after 1 hour (not 24h) since autonomous agents move fast
- `escalateAfterMs: 600000` — escalate after 10 minutes if you haven't responded
- `rateLimit.maxOpsPerMinute: 60` — prevent runaway agent loops

---

## Troubleshooting

### OpenClaw can't reach an MCP server after wrapping

Run `openclaw doctor` to check server connectivity. Confirm `agentsgate` is in your PATH:

```bash
which agentsgate
```

If not found, add npm's global bin to your PATH (see the installation guide).

### Operations appear in the dashboard but OpenClaw seems slow

Each tool call now waits for AgentsGate to score and log it — this adds ~5ms per call. If an operation is stuck awaiting approval, OpenClaw is waiting for you. Check `http://localhost:4001/approvals` or run `agentsgate approvals`.

### A legitimate operation keeps getting blocked

Identify the rule blocking it:

```bash
agentsgate audit --action=block --agentId=openclaw
```

Look at the `reasons` field to see which rule fired. Either:
1. Add an exception rule in `policy.json` with `action: allow` and higher priority (lower number)
2. Raise the `blockAtOrAbove` threshold
3. Mute the specific built-in rule: `"mutedRules": ["L1_OVERWRITE_FILE"]`

### How to remove AgentsGate from OpenClaw

Restore the original `mcpServers` commands in `~/.openclaw/openclaw.json` (remove the `agentsgate proxy stdio --cmd` wrapping, put back the original `command` values).

---

## Security Notes Specific to OpenClaw

OpenClaw's `exec`/`shell` tool can run arbitrary commands on your machine. With AgentsGate, every shell execution is:
- **Logged** with the full command string
- **Checkpointed** if it touches files
- **Scoreable** at 0.80–0.85 by default (L1_EXECUTE_COMMAND)
- **Blockable or approval-gated** by your policy

Recommended minimum protections:
1. Never disable the `L1_EXECUTE_COMMAND` rule
2. Set `blockAtOrAbove` ≤ 0.70 to block the most dangerous commands automatically
3. Enable Slack notifications so you're alerted to approvals even when away
4. Set an API key on the dashboard — OpenClaw users sometimes run the agent unattended for hours

---
---

# 日本語ガイド

## OpenClawユーザーにAgentsGateが必要な理由

OpenClawは強力な自律型AIエージェントです。ファイルシステムの操作、シェルコマンドの実行、ウェブブラウジング、メッセージ送信、数百の外部API呼び出しを、あなたの許可なしに行えます。これにより高速で生産的になりますが、同時に以下のリスクも生じます：

- 指示の誤解により間違ったファイルが削除される
- AIの幻覚により破壊的なシェルコマンドが実行される
- 侵害されたMCPサーバーによりデータが密かに持ち出される
- エージェントが何をしたか、なぜしたかの監査証跡がない

**AgentsGateがこのギャップを埋めます。** OpenClawとそれが呼び出すすべてのMCPツールの間に透過的なプロキシとして機能します。すべてのツール呼び出しは傍受され、リスクスコアが付けられ、ログに記録されます。危険な場合は、実行前に承認を求めるか、完全にブロックします。何かまずいことが起きたら、被害が発生する直前に取られたスナップショットに復元できます。

```
OpenClawエージェント
      ↓  MCP (stdio)
┌─────────────────────┐
│  AgentsGateプロキシ│  ← すべてのツール呼び出しを傍受
└──────┬──────────────┘
       │  リスクスコア付与、ログ、チェックポイント
       ↓
  ┌────┴────┐  ┌──────────────┐  ┌─────────────────┐
  │ファイル │  │ブラウザ/    │  │シェル / exec   │
  │システム │  │ ウェブ      │  │  サーバー       │
  └─────────┘  └─────────────┘  └─────────────────┘
```

---

## 前提条件

- **AgentsGate** インストール済み：`npm install -g agentsgate`
- **OpenClaw** インストール済みかつ動作中：`openclaw --version`
- OpenClawの設定ファイルが `~/.openclaw/openclaw.json` にある

AgentsGateをまだインストールしていない場合は [docs/installation-guide.md](installation-guide.md) をご覧ください。

---

## ステップ1 — AgentsGateを起動する

OpenClawを起動する前に、AgentsGateを起動します：

```bash
agentsgate start
```

これにより以下が起動します：
- **プロキシ** ポート `4000` — MCPツール呼び出しを傍受
- **ダッシュボード** ポート `4001` — `http://localhost:4001`

このターミナルは開いたままにしてください。OpenClawを使用する間、AgentsGateを実行し続ける必要があります。

---

## ステップ2 — OpenClawのMCPサーバーをAgentsGateでラップする

OpenClawはMCPサーバーと `stdio` トランスポートを使用して通信します — 各サーバーを子プロセスとして起動します。AgentsGateは各サーバーコマンドをラップして、すべてのトラフィックがプロキシを通過するようにします。

### 仕組み

OpenClawが直接MCPサーバーと通信する代わりに：

```
OpenClaw  →  mcp-filesystem  （直接、無防備）
```

AgentsGateのstdioプロキシを通じて実際のサーバーを起動するように設定します：

```
OpenClaw  →  agentsgate proxy  →  mcp-filesystem  （保護済み）
```

### `~/.openclaw/openclaw.json` を編集する

OpenClawの設定ファイルを開きます。`mcpServers` セクションを見つけて、各サーバーを `agentsgate proxy` でラップします。

#### 変更前（無防備）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "mcp-filesystem",
      "args": ["--root", "/home/user/projects"]
    },
    "browser": {
      "command": "mcp-browser",
      "args": []
    },
    "shell": {
      "command": "mcp-shell",
      "args": ["--allow", "/home/user"]
    }
  }
}
```

#### 変更後（AgentsGateで保護済み）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-filesystem",
        "--args", "--root,/home/user/projects",
        "--agentId", "openclaw",
        "--tool", "filesystem"
      ]
    },
    "browser": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-browser",
        "--agentId", "openclaw",
        "--tool", "browser"
      ]
    },
    "shell": {
      "command": "agentsgate",
      "args": [
        "proxy", "stdio",
        "--cmd", "mcp-shell",
        "--args", "--allow,/home/user",
        "--agentId", "openclaw",
        "--tool", "shell"
      ]
    }
  }
}
```

**主要パラメータ：**
| パラメータ | 説明 |
|-----------|------|
| `proxy stdio` | AgentsGateのstdioプロキシモードを使用 |
| `--cmd` | 元のMCPサーバーコマンド |
| `--args` | カンマ区切りの元の引数 |
| `--agentId` | ダッシュボードでのエージェントラベル（例：`openclaw`） |
| `--tool` | ダッシュボードとポリシールールで使用されるツール名 |

ファイルを保存すると、OpenClawは設定を自動的にホットリロードします。次回OpenClawがツールを呼び出すとき、それはAgentsGateを通じて流れます。

---

## ステップ3 — 接続を確認する

MCPサーバーにアクセスできることを確認するために `openclaw doctor` を実行します：

```bash
openclaw doctor
```

次に `http://localhost:4001` でAgentsGateダッシュボードを開き、OpenClawに簡単な操作（例：ディレクトリ内のファイルの一覧表示）を依頼します。すぐに **Overview** タブの操作一覧に操作が表示されるはずです。

---

## ステップ4 — OpenClaw専用のポリシーを設定する

OpenClawはシェルコマンドを実行し、ウェブをブラウジングし、ファイルを自律的に書き込めるため、デフォルトよりも厳格なポリシーをお勧めします。

`~/.agentsgate/policy.json` を作成します：

```json
{
  "thresholds": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.65
  },
  "rules": [
    {
      "id": "シェルコマンドには承認を要求",
      "description": "すべてのシェルコマンド実行に承認を要求",
      "match": {
        "tool": "shell",
        "method": "/exec|run|spawn|shell/"
      },
      "action": "require_approval",
      "priority": 5
    },
    {
      "id": "ホームディレクトリの削除をブロック",
      "description": "ホームディレクトリ内のすべての削除をブロック",
      "match": {
        "tool": "filesystem",
        "method": "/delete|rm|unlink/",
        "pathPattern": "^/home/"
      },
      "action": "block",
      "priority": 1
    },
    {
      "id": "ドットファイルを保護",
      "description": "隠し設定ファイルへの書き込み前に承認を要求",
      "match": {
        "tool": "filesystem",
        "pathPattern": "/\\.[a-zA-Z]"
      },
      "action": "require_approval",
      "priority": 2
    },
    {
      "id": "認証情報ファイルを保護",
      "description": "認証情報・シークレットファイルへのアクセスをブロック",
      "match": {
        "pathPattern": "(\\.env|\\.ssh|\\.aws|credentials|secrets|api.key)"
      },
      "action": "block",
      "priority": 1
    },
    {
      "id": "外部URLへのPOSTには承認を要求",
      "description": "OpenClawが外部URLにデータをPOSTする前に承認を要求",
      "match": {
        "tool": "browser",
        "method": "/post|submit|send|upload/"
      },
      "action": "require_approval",
      "priority": 10
    },
    {
      "id": "機密パラメータを秘匿",
      "description": "APIキーとパスワードを監査ログからマスク",
      "match": { "agentId": "openclaw" },
      "redact": ["apiKey", "api_key", "password", "secret", "token", "authorization"],
      "priority": 100
    }
  ],
  "agents": {
    "toolRules": {
      "openclaw": {
        "allowlist": ["filesystem", "browser", "shell", "web_search", "web_fetch"]
      }
    }
  },
  "ruleOverrides": {
    "L1_EXECUTE_COMMAND": 0.85,
    "L1_DELETE_FILE": 0.95
  }
}
```

再起動なしでポリシーをリロードします：

```bash
agentsgate config reload
```

---

## ステップ5 — Slack通知を有効にする（推奨）

OpenClawが承認をトリガーしたりブロックされたりしたとき、即座にSlackアラートを受け取ります：

```json
{
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"
  }
}
```

これを `~/.agentsgate/config.json` に追加します。これにより、デスクから離れているときでも、OpenClawが危険なことを試みるたびにSlackメッセージを受け取れます。

---

## 日常的なワークフロー

### OpenClawの動作をリアルタイムで監視する

OpenClawの実行中は `http://localhost:4001` のダッシュボードを開いたままにします。**Overview** タブの操作一覧には、すべてのツール呼び出し、リスクスコア、決定のライブフィードが表示されます。

ダッシュボードの色分け：
- 🟢 **緑** — 許可済み（推奨ポリシーではスコア < 0.20）
- 🟡 **黄** — あなたの承認が必要（スコア 0.20〜0.64）
- 🔴 **赤** — ブロック済み（スコア ≥ 0.65）

### 一時停止した操作を承認する

OpenClawがリスクの高いステップに達すると、一時停止して待機します。ダッシュボードの **Approvals** タブに保留中の承認が表示されます。

1. `http://localhost:4001` → **Overview** tab, pending-approval list を開く
2. 保留中の操作をクリック
3. 確認：どのツール、どのメソッド、どのファイルパスまたはコマンドか
4. **Approve**（OpenClawが続行）または **Deny**（OpenClawがエラーを受け取る）をクリック

CLIから：

```bash
agentsgate approvals
agentsgate approvals approve <id>
agentsgate approvals deny <id>
```

### ミスの後にロールバックする

OpenClawが意図しないことをした場合、直前に取られたチェックポイントを見つけます：

```bash
# タイムスタンプ付きでチェックポイントを一覧表示
agentsgate checkpoints

# 何が復元されるかをプレビュー（安全 — 変更なし）
agentsgate rollback <checkpoint-id> --preview

# ファイルを復元
agentsgate rollback <checkpoint-id>
```

またはダッシュボードの **Checkpoints** タブを使用します。

---

## 新しいタスクにドライランモードを使用する

OpenClawに新しい、複雑な、または慣れないタスクを与えるとき、強制なしに何をするかを確認するためにドライランモードで開始します：

```bash
# 現在のAgentsGateを停止してドライランモードで再起動
agentsgate stop
agentsgate start --dry-run
```

ドライランモードでは、OpenClawは自由に動作しますが、すべてのアクションは*本来どうなるはずだったか*という決定とともにログに記録されます。タスクが完了したらダッシュボードを確認し、その内容に基づいてポリシーを調整します。準備ができたら通常モードで再起動します：

```bash
agentsgate stop
agentsgate start
```

---

## OpenClawのアクティビティを確認する

### 完全な監査ログを表示する

```bash
agentsgate audit --agentId=openclaw
```

### ブロックされた操作のみを表示する

```bash
agentsgate audit --agentId=openclaw --action=block
```

### 確認用にエクスポートする

```bash
agentsgate ops export --format=json --out=openclaw-session.json
```

### リスクサマリーを生成する

```bash
agentsgate report
```

---

## OpenClaw向け推奨設定

### `~/.agentsgate/config.json`

```json
{
  "proxy": {
    "port": 4000,
    "checkpointThreshold": 0.20
  },
  "intervention": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.65
  },
  "approvals": {
    "maxAgeMs": 3600000,
    "escalateAfterMs": 600000
  },
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/..."
  },
  "rateLimit": {
    "enabled": true,
    "maxOpsPerMinute": 60
  },
  "dashboard": {
    "apiKey": "your-strong-random-key"
  },
  "audit": {
    "signingSecret": "your-strong-hmac-secret"
  }
}
```

**OpenClaw向けの注目設定：**
- `checkpointThreshold: 0.20` — 中リスクの操作でもファイルをスナップショット
- `maxAgeMs: 3600000` — 承認は1時間後に期限切れ（自律エージェントは速く動く）
- `escalateAfterMs: 600000` — 応答がない場合は10分後にエスカレーション
- `rateLimit.maxOpsPerMinute: 60` — エージェントの暴走ループを防止

---

## トラブルシューティング

### ラッピング後にOpenClawがMCPサーバーに接続できない

`openclaw doctor` を実行してサーバーの接続性を確認します。`agentsgate` がPATHにあることを確認します：

```bash
which agentsgate
```

見つからない場合は、npmのグローバルbinをPATHに追加してください（インストールガイドを参照）。

### 操作はダッシュボードに表示されるがOpenClawが遅い

各ツール呼び出しはAgentsGateがスコアリングしてログに記録するのを待つ必要があります — これにより呼び出しごとに約5msの遅延が加わります。操作が **Approvals** で止まっている場合、OpenClawはあなたを待っています。`http://localhost:4001/approvals` を確認するか `agentsgate approvals` を実行してください。

### 正当な操作が繰り返しブロックされる

ブロックしているルールを特定します：

```bash
agentsgate audit --action=block --agentId=openclaw
```

`reasons` フィールドを見てどのルールが発動したか確認します。次のいずれかを行います：
1. `policy.json` に `action: allow` と高い優先度（低い数値）の例外ルールを追加する
2. `blockAtOrAbove` のしきい値を上げる
3. 特定の組み込みルールをミュートする：`"mutedRules": ["L1_OVERWRITE_FILE"]`

### OpenClawからAgentsGateを削除する方法

`~/.openclaw/openclaw.json` の元の `mcpServers` コマンドを復元します（`agentsgate proxy stdio --cmd` のラッピングを削除し、元の `command` 値を戻す）。

---

## OpenClaw固有のセキュリティに関する注意事項

OpenClawの `exec`/`shell` ツールはマシン上で任意のコマンドを実行できます。AgentsGateを使用すると、すべてのシェル実行は：
- 完全なコマンド文字列とともに **ログに記録される**
- ファイルを操作する場合は **チェックポイントが保存される**
- デフォルトで 0.80〜0.85 のスコアが付けられる（L1_EXECUTE_COMMAND）
- あなたのポリシーにより **ブロックまたは承認ゲート** される

最低限の推奨保護設定：
1. `L1_EXECUTE_COMMAND` ルールを無効にしない
2. 最も危険なコマンドを自動的にブロックするために `blockAtOrAbove` を 0.70 以下に設定する
3. 席を離れているときに承認の通知を受け取るためにSlack通知を有効にする
4. ダッシュボードにAPIキーを設定する — OpenClawユーザーはエージェントを何時間も無人で実行することがある
