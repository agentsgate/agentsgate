# AgentsGate — Installation Guide for Beginners
# AgentsGate — 初心者向けインストールガイド

---

## Table of Contents / 目次

- [English Guide](#english-guide)
- [日本語ガイド](#日本語ガイド)

---

# English Guide

## What is AgentsGate?

AgentsGate is a safety layer that sits between your AI agent (such as Claude) and the tools it uses. Every action your AI agent takes — reading files, running commands, calling APIs — passes through AgentsGate first. AgentsGate records it, scores it for risk, and can pause dangerous actions for your approval before they happen.

**In plain terms:** AgentsGate is like a security guard for your AI agent. It watches everything, keeps a log, and stops anything that looks dangerous.

---

## Prerequisites

Before installing AgentsGate, make sure you have:

| Requirement | Minimum Version | How to check |
|-------------|----------------|--------------|
| Node.js | 20.0.0 or newer | `node --version` |
| npm | 8.0.0 or newer | `npm --version` |
| Git | Any recent version | `git --version` |

### Installing Node.js

If you don't have Node.js installed, download it from **https://nodejs.org** and choose the **LTS** version.

After installation, open a terminal and verify:

```bash
node --version   # Should print v20.x.x or higher
npm --version    # Should print 8.x.x or higher
```

---

## Step 1 — Install AgentsGate

Install AgentsGate globally using npm so the `agentsgate` command is available everywhere:

```bash
npm install -g agentsgate
```

Verify the installation:

```bash
agentsgate --version
```

You should see output like `AgentsGate v0.1.3` — the version prints on its own line.

> **Tip:** If you get a "permission denied" error on macOS/Linux, prefix the command with `sudo`:
> ```bash
> sudo npm install -g agentsgate
> ```

---

## Step 2 — Start AgentsGate

Start the AgentsGate proxy with default settings:

```bash
agentsgate start
```

This starts:
- **Proxy** on port `4000` — intercepts all MCP tool calls
- **Dashboard** on port `4001` — web interface for monitoring

You should see output like:

```
[agentsgate] Proxy listening on :4000
[agentsgate] Dashboard API listening on :4001
```

Leave this terminal window open. AgentsGate must stay running to protect your AI agent.

### Check that it is running

Open a **new terminal** and run:

```bash
agentsgate status
```

You should see a status report showing the proxy is active.

---

## Step 3 — Connect Claude Desktop (optional but recommended)

If you use Claude Desktop, AgentsGate can automatically configure it.

**Make sure Claude Desktop is closed before running this command.**

```bash
agentsgate inject
```

This command edits Claude Desktop's configuration file to route all MCP tool calls through AgentsGate. You should see:

```
[agentsgate] Injected into Claude Desktop config.
Restart Claude Desktop to activate.
```

Now restart Claude Desktop. All tool calls made by Claude will now pass through AgentsGate automatically.

To undo this at any time:

```bash
agentsgate eject
```

---

## Step 4 — Open the Dashboard

Open your browser and go to:

```
http://localhost:4001
```

You will see the AgentsGate dashboard with:
- **Operations** — a live feed of every tool call your AI agent has made
- **Risk scores** — how dangerous each operation was rated
- **Agents** — which AI agents are connected
- **Approvals** — operations waiting for your approval

---

## Step 5 — Test that it works

With Claude Desktop open and connected, ask Claude to do something simple, like read a file or list a directory. You should immediately see the operation appear in the dashboard at `http://localhost:4001`.

---

## Common Commands

| Command | What it does |
|---------|-------------|
| `agentsgate start` | Start the proxy and dashboard |
| `agentsgate start 8080` | Start on a custom port (dashboard on 8081) |
| `agentsgate status` | Show current status |
| `agentsgate inject` | Configure Claude Desktop automatically |
| `agentsgate eject` | Remove Claude Desktop configuration |
| `agentsgate audit` | Show the audit log of all past operations |
| `agentsgate report` | Generate a risk summary report |
| `agentsgate config` | Show current configuration |
| `agentsgate health` | Check dashboard health |
| `agentsgate level` | Show what is being stopped, and change it |

---

## How much does it stop?

Out of the box AgentsGate runs at the **`balanced`** protection level: it
refuses anything that wipes data — `DROP TABLE`, a `DELETE` with no `WHERE` —
and anything writing to a credential file such as `.env`. Deleting a directory
or running `rm -rf` waits for your yes. Everything else stays out of the way. Writing code, running tests and editing rows all go through
without a prompt.

```bash
agentsgate level                # see exactly what is stopped, and why
```

Two other levels:

| Level | For |
|-------|-----|
| `minimal` | A scratch project. Only wholesale destruction is stopped. |
| `balanced` | **Default.** Your own project, with real data in it. |
| `strict` | Data that is not only yours — holds personal-data reads, outbound sends, shell commands and deletions for approval. |

```bash
agentsgate level strict
```

The dashboard has the same switch in its header, and changing it there takes
effect immediately.

---

## Configuration (optional)

AgentsGate works with zero configuration out of the box. When you need to customize it, create a config file:

**Location:**
- macOS / Linux: `~/.agentsgate/config.json`
- Windows: `C:\Users\<YourName>\.agentsgate\config.json`

**Example config:**

```json
{
  "port": 4000,
  "dashboardPort": 4001,
  "logLevel": "info",
  "policy": {
    "rules": [
      {
        "name": "block-rm-rf",
        "tool": "bash",
        "pathPattern": ".*",
        "action": "block",
        "reason": "Dangerous shell command"
      }
    ]
  }
}
```

See [docs/policy-guide.md](policy-guide.md) for all available policy options.

---

## Using Docker (alternative installation)

If you prefer Docker, AgentsGate includes a ready-to-use Docker image:

```bash
# Clone the repository
git clone https://github.com/agentsgate/agentsgate.git
cd agentsgate

# Start with Docker Compose
docker compose up -d

# Check it is running
docker compose logs -f agentsgate
```

The proxy will be available on port `4000` and the dashboard on port `4001`.

---

## Troubleshooting

### "Command not found: agentsgate"

npm's global bin directory may not be in your PATH. Run:

```bash
npm bin -g    # Shows the directory where global binaries are installed
```

Add that directory to your PATH, or use `npx agentsgate` instead.

### Port already in use

If port 4000 or 4001 is taken by another application, start AgentsGate on a
different port. The dashboard is always the proxy port plus one, so this puts
it on 4101 — there is no separate flag for it:

```bash
agentsgate start 4100
```

### Claude Desktop does not connect

1. Make sure you ran `agentsgate inject` before opening Claude Desktop
2. Restart Claude Desktop after injection
3. Run `agentsgate status` to confirm the proxy is still running

### Viewing logs

AgentsGate logs all operations to SQLite. To view recent activity:

```bash
agentsgate audit
```

---

## Uninstalling

```bash
# Remove Claude Desktop integration first
agentsgate eject

# Stop AgentsGate (Ctrl+C in the terminal where it is running)

# Uninstall the package
npm uninstall -g agentsgate
```

---

## Next Steps

- Read [docs/policy-guide.md](policy-guide.md) to write custom safety rules
- Read [docs/api-reference.md](api-reference.md) to use the REST API
- Read [SECURITY.md](../SECURITY.md) for security best practices

---
---

# 日本語ガイド

## AgentsGateとは？

AgentsGateは、あなたのAIエージェント（Claudeなど）と、AIが使用するツールの間に置くセキュリティレイヤーです。AIエージェントが行うすべてのアクション（ファイルの読み取り、コマンドの実行、APIの呼び出しなど）は、最初にAgentsGateを通過します。AgentsGateはその操作を記録し、リスクスコアを付け、危険な操作が実行される前に承認を求めることができます。

**わかりやすく言うと：** AgentsGateはAIエージェントのセキュリティガードです。すべての操作を監視し、ログを保存し、危険に見えるものを止めます。

---

## 必要な環境

AgentsGateをインストールする前に、以下が必要です：

| 必要なもの | 最低バージョン | 確認方法 |
|-----------|--------------|---------|
| Node.js | 20.0.0以上 | `node --version` |
| npm | 8.0.0以上 | `npm --version` |
| Git | 最近のバージョンであれば可 | `git --version` |

### Node.jsのインストール

Node.jsがインストールされていない場合は、**https://nodejs.org** からダウンロードし、**LTS**バージョンを選択してください。

インストール後、ターミナルを開いて確認します：

```bash
node --version   # v20.x.x以上が表示されるはず
npm --version    # 8.x.x以上が表示されるはず
```

---

## ステップ1 — AgentsGateのインストール

npmを使ってAgentsGateをグローバルにインストールします。これにより、どこからでも`agentsgate`コマンドが使えるようになります：

```bash
npm install -g agentsgate
```

インストールを確認します：

```bash
agentsgate --version
```

`AgentsGate v0.1.3` のような出力が表示されます（バージョンのみが出力されます）。

> **ヒント：** macOS/Linuxで「permission denied（権限エラー）」が出た場合は、コマンドの前に`sudo`を付けてください：
> ```bash
> sudo npm install -g agentsgate
> ```

---

## ステップ2 — AgentsGateの起動

デフォルト設定でAgentsGateプロキシを起動します：

```bash
agentsgate start
```

これにより以下が起動します：
- **プロキシ** ポート`4000` — すべてのMCPツール呼び出しを傍受
- **ダッシュボード** ポート`4001` — 監視用のWebインターフェース

以下のような出力が表示されるはずです：

```
[agentsgate] Proxy listening on :4000
[agentsgate] Dashboard API listening on :4001
```

このターミナルウィンドウは開いたままにしておいてください。AgentsGateがAIエージェントを保護するには、実行中である必要があります。

### 起動確認

**新しいターミナル**を開いて実行します：

```bash
agentsgate status
```

プロキシがアクティブであることを示すステータスレポートが表示されるはずです。

---

## ステップ3 — Claude Desktopへの接続（任意、推奨）

Claude Desktopを使用している場合、AgentsGateが自動的に設定できます。

**このコマンドを実行する前に、Claude Desktopを閉じてください。**

```bash
agentsgate inject
```

このコマンドにより、Claude Desktopの設定ファイルが編集され、すべてのMCPツール呼び出しがAgentsGateを経由するようになります。以下のような出力が表示されます：

```
[agentsgate] Injected into Claude Desktop config.
Restart Claude Desktop to activate.
```

Claude Desktopを再起動してください。これ以降、Claudeが行うすべてのツール呼び出しは自動的にAgentsGateを通過します。

この設定を元に戻したい場合は：

```bash
agentsgate eject
```

---

## ステップ4 — ダッシュボードを開く

ブラウザを開いて以下のURLにアクセスします：

```
http://localhost:4001
```

AgentsGateダッシュボードが表示されます：
- **Operations（操作）** — AIエージェントが行ったすべてのツール呼び出しのライブフィード
- **Risk scores（リスクスコア）** — 各操作の危険度評価
- **Agents（エージェント）** — 接続しているAIエージェント
- **Approvals（承認待ち）** — あなたの承認を待っている操作

---

## ステップ5 — 動作確認

Claude Desktopを開いた状態で、ファイルの読み取りやディレクトリの一覧表示など、簡単な操作をClaudeに依頼してください。すぐに`http://localhost:4001`のダッシュボードにその操作が表示されるはずです。

---

## よく使うコマンド一覧

| コマンド | 説明 |
|---------|------|
| `agentsgate start` | プロキシとダッシュボードを起動 |
| `agentsgate start 8080` | 別のポートで起動（ダッシュボードは 8081） |
| `agentsgate status` | 現在のステータスを表示 |
| `agentsgate inject` | Claude Desktopを自動設定 |
| `agentsgate eject` | Claude Desktopの設定を削除 |
| `agentsgate audit` | 過去のすべての操作の監査ログを表示 |
| `agentsgate report` | リスクサマリーレポートを生成 |
| `agentsgate config` | 現在の設定を表示 |
| `agentsgate health` | ダッシュボードの健全性を確認 |
| `agentsgate level` | 何を止めているかを表示・変更 |

---

## どこまで止めるか

既定の保護レベルは **`balanced`** です。データを消し飛ばすもの（`DROP TABLE`、
`WHERE` 句のない `DELETE`）と、`.env` のような認証情報ファイルへの書き込みを拒否し、
それ以外は邪魔をしません。コードを書く、テストを走らせる、行を更新する——
いずれも確認を求められずに通ります。

```bash
agentsgate level                # 何が止まるのか、その理由を表示
```

他に 2 つあります。

| レベル | 想定 |
|--------|------|
| `minimal` | 使い捨てのプロジェクト。全消し系だけを止めます |
| `balanced` | **既定。** 実データの入った自分のプロジェクト |
| `strict` | 自分だけのものではないデータ。個人情報の読み出し・外部への送信・シェル実行・削除を承認対象にします |

```bash
agentsgate level strict
```

ダッシュボードのヘッダにも同じ切り替えがあり、そちらで変更すると即座に反映されます。

---

## 設定（任意）

AgentsGateはゼロ設定ですぐに使えます。カスタマイズが必要な場合は、設定ファイルを作成してください：

**ファイルの場所：**
- macOS / Linux: `~/.agentsgate/config.json`
- Windows: `C:\Users\<ユーザー名>\.agentsgate\config.json`

**設定例：**

```json
{
  "port": 4000,
  "dashboardPort": 4001,
  "logLevel": "info",
  "policy": {
    "rules": [
      {
        "name": "危険なコマンドをブロック",
        "tool": "bash",
        "pathPattern": ".*",
        "action": "block",
        "reason": "危険なシェルコマンド"
      }
    ]
  }
}
```

利用可能なポリシーオプションの詳細は [docs/policy-guide.md](policy-guide.md) を参照してください。

---

## Dockerを使う場合（代替インストール方法）

Dockerを使う場合、AgentsGateにはすぐに使えるDockerイメージが含まれています：

```bash
# リポジトリをクローン
git clone https://github.com/agentsgate/agentsgate.git
cd agentsgate

# Docker Composeで起動
docker compose up -d

# ログを確認
docker compose logs -f agentsgate
```

プロキシはポート`4000`で、ダッシュボードはポート`4001`で利用できます。

---

## トラブルシューティング

### 「コマンドが見つかりません: agentsgate」

npmのグローバルbinディレクトリがPATHに含まれていない可能性があります。以下を実行してください：

```bash
npm bin -g    # グローバルバイナリのインストール先を表示
```

そのディレクトリをPATHに追加するか、`npx agentsgate`を代わりに使用してください。

### ポートが使用中

ポート 4000 または 4001 が他のアプリケーションで使用されている場合は、別のポートで起動します。
ダッシュボードは常にプロキシのポート +1 になるため、この例では 4101 です（個別に指定するオプションはありません）：

```bash
agentsgate start 4100
```

### Claude Desktopが接続しない

1. Claude Desktopを開く前に`agentsgate inject`を実行したか確認してください
2. inject後にClaude Desktopを再起動してください
3. `agentsgate status`を実行してプロキシがまだ起動中か確認してください

### ログの確認

AgentsGateはすべての操作をSQLiteに記録します。最近のアクティビティを確認するには：

```bash
agentsgate audit
```

---

## アンインストール

```bash
# 最初にClaude Desktopの連携を解除
agentsgate eject

# AgentsGateを停止（起動中のターミナルでCtrl+C）

# パッケージをアンインストール
npm uninstall -g agentsgate
```

---

## 次のステップ

- カスタムセキュリティルールの作成 → [docs/policy-guide.md](policy-guide.md)
- REST APIの使用 → [docs/api-reference.md](api-reference.md)
- セキュリティのベストプラクティス → [SECURITY.md](../SECURITY.md)
