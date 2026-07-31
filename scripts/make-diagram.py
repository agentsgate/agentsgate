# -*- coding: utf-8 -*-
"""
Draw docs/assets/agentsgate-pipeline{,-jp}.png — the figure on the README and in
the beginner guides.

    pip install Pillow
    python scripts/make-diagram.py

Why a picture rather than the ASCII art it replaced: the art had to line up in a
monospace grid, and every kana is two cells wide, so a box sized for English
breaks in Japanese and one sized for Japanese leaves English full of gaps. Both
editions now say the same thing and both look right.

Rendered at 3x and downsampled, so it holds up in print.

Edit the EN and JA dictionaries at the foot of this file to change the wording.
Keep the figure and its caption in step with the text around them — the caption
exists so the picture is not the only thing carrying the meaning.

macOS only as written: the font paths below are Hiragino and Menlo. On another
platform, point them at any two CJK-capable faces and a monospace one.
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ModuleNotFoundError:
    sys.exit('Pillow is required:  pip install Pillow')

S = 3                     # supersample factor
W, H = 1040, 660          # logical size

JP_REG = '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc'
JP_BOLD = '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc'
MONO = '/System/Library/Fonts/Menlo.ttc'

for _path in (JP_REG, JP_BOLD, MONO):
    if not os.path.exists(_path):
        sys.exit(
            f'Font not found: {_path}\n'
            'These paths are macOS system fonts. On another platform, edit\n'
            'JP_REG / JP_BOLD / MONO at the top of this file to point at any two\n'
            'CJK-capable faces and one monospace face.'
        )

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, os.pardir, 'docs', 'assets')

INK = (28, 32, 38)
MUTED = (110, 120, 132)
LINE = (176, 186, 198)
BOX = (247, 249, 251)
ACCENT = (37, 99, 235)      # the two stages the reader should notice
ALLOW = (22, 143, 92)
HOLD = (194, 124, 12)
BLOCK = (200, 52, 52)


def font(path, size, index=0):
    return ImageFont.truetype(path, size * S, index=index)


def draw_diagram(out_path, t):
    img = Image.new('RGB', (W * S, H * S), 'white')
    d = ImageDraw.Draw(img)

    f_title = font(JP_BOLD, 17)
    f_step = font(JP_BOLD, 15)
    f_body = font(JP_REG, 12)
    f_small = font(JP_REG, 11)
    f_mono = font(MONO, 11)
    f_tag = font(JP_BOLD, 11)

    def text(x, y, s, fnt, fill=INK, anchor='la'):
        d.text((x * S, y * S), s, font=fnt, fill=fill, anchor=anchor)

    def rrect(x1, y1, x2, y2, radius=8, fill=None, outline=LINE, width=1.4):
        d.rounded_rectangle([x1 * S, y1 * S, x2 * S, y2 * S], radius=radius * S,
                            fill=fill, outline=outline, width=max(1, int(width * S)))

    def line(x1, y1, x2, y2, fill=LINE, width=1.4):
        d.line([x1 * S, y1 * S, x2 * S, y2 * S], fill=fill, width=max(1, int(width * S)))

    def arrow_down(x, y1, y2, fill=LINE):
        line(x, y1, x, y2, fill=fill)
        d.polygon([(x * S, y2 * S), ((x - 4.5) * S, (y2 - 8) * S), ((x + 4.5) * S, (y2 - 8) * S)], fill=fill)

    # ── agent ────────────────────────────────────────────────────────────
    text(60, 26, t['agent'], f_title)
    arrow_down(76, 52, 88)
    text(92, 60, t['mcp'], f_small, MUTED)

    # ── proxy ────────────────────────────────────────────────────────────
    rrect(60, 92, 640, 132, fill=BOX)
    text(80, 104, 'AgentsGate Proxy', f_title)
    text(400, 107, t['through'], f_small, MUTED)

    # ── the rail the three stages hang off ───────────────────────────────
    rail = 96
    line(rail, 132, rail, 468)

    steps = [
        ('①', t['s1'], t['s1a'], t['s1b'], None),
        ('②', t['s2'], t['s2a'], t['s2b'], t['tag_broad']),
        ('③', t['s3'], t['s3a'], t['s3b'], t['tag_narrow']),
    ]
    y = 158
    for num, title, l1, l2, tag in steps:
        highlight = tag is not None
        colour = ACCENT if highlight else INK
        line(rail, y + 14, rail + 22, y + 14)
        text(rail + 30, y, num, f_step, colour)
        text(rail + 58, y, title, f_step, colour)
        if tag:
            tw = d.textlength(tag, font=f_tag) / S
            rrect(rail + 62 + d.textlength(title, font=f_step) / S + 14, y + 1,
                  rail + 62 + d.textlength(title, font=f_step) / S + 26 + tw, y + 21,
                  radius=9, fill=(232, 240, 254), outline=(191, 214, 250))
            text(rail + 62 + d.textlength(title, font=f_step) / S + 20, y + 5, tag, f_tag, ACCENT)
        text(rail + 58, y + 28, l1, f_body, MUTED)
        if l2:
            text(rail + 58, y + 48, l2, f_mono if num == '①' else f_body,
                 MUTED if num != '②' else INK)
        y += 104

    # ── verdict ──────────────────────────────────────────────────────────
    arrow_down(rail, 468, 496)
    rrect(60, 500, 300, 538, fill=BOX)
    text(80, 511, t['verdict'], f_step)
    text(320, 505, t['logged1'], f_small, MUTED)
    text(320, 522, t['logged2'], f_small, MUTED)

    # ── outcomes ─────────────────────────────────────────────────────────
    outs = [(t['allow'], t['allow_sub'], ALLOW),
            (t['hold'], t['hold_sub'], HOLD),
            (t['block'], t['block_sub'], BLOCK)]

    # Each box is as wide as the longer of its two lines, so Japanese labels —
    # which are far wider than their English counterparts — cannot overflow.
    PAD, GAP = 16, 26
    widths = [max(d.textlength(a, font=f_step), d.textlength(b, font=f_small)) / S + PAD * 2
              for a, b, _ in outs]
    x = 80
    xs = []
    for w in widths:
        xs.append(x)
        x += w + GAP

    line(120, 538, 120, 566)
    line(120, 566, xs[-1] + widths[-1] / 2, 566)
    for (label, sub, colour), x0, w in zip(outs, xs, widths):
        cx = x0 + w / 2
        line(cx, 566, cx, 582)
        rrect(x0, 582, x0 + w, 626, fill='white', outline=colour, width=1.6)
        text(x0 + PAD, 592, label, f_step, colour)
        text(x0 + PAD, 610, sub, f_small, MUTED)

    img.resize((W, H), Image.LANCZOS).save(out_path, 'PNG', optimize=True)
    print('  wrote', out_path)


EN = dict(
    agent='AI Agent  (Claude, GPT, and so on)', mcp='MCP protocol',
    through='every tool call passes through here',
    s1='Risk rules', s1a='What kind of operation is this, and how risky?',
    s1b='DROP TABLE → 1.00 "destructive"    write a file → 0.65 "write_update"',
    s2='Protection level', s2a='What to do with that category',
    s2b='minimal   /   balanced (default)   /   strict',
    s3='Policy rules', s3a='Your exceptions — overrides the level, tighter OR looser',
    s3b='block writes under /etc  ·  allow rm -rf node_modules',
    tag_broad='one setting, covers everything', tag_narrow='case by case',
    verdict='Verdict',
    logged1='Every operation is logged, whatever the verdict.',
    logged2='Risky ones are checkpointed first, so they can be rolled back.',
    allow='allow', allow_sub='runs immediately',
    hold='require_approval', hold_sub='held until you say yes',
    block='block', block_sub='refused, reason logged',
)

JA = dict(
    agent='AI エージェント（Claude、GPT など）', mcp='MCP プロトコル',
    through='すべてのツール呼び出しがここを通る',
    s1='リスクルール', s1a='どんな種類の操作か、どれくらい危険か',
    s1b='DROP TABLE → 1.00 "destructive"    file write → 0.65 "write_update"',
    s2='保護レベル', s2a='そのカテゴリをどう扱うか',
    s2b='minimal   /   balanced（既定）   /   strict',
    s3='ポリシールール', s3a='個別の例外 — レベルを上書きし、厳しくも緩くもできる',
    s3b='/etc 配下への書き込みを拒否  ·  rm -rf node_modules を許可',
    tag_broad='全体に 1 つの大まかな設定', tag_narrow='ケースごと',
    verdict='判定結果',
    logged1='判定に関わらず、すべての操作がログに残る。',
    logged2='危険なものは事前にチェックポイントを取り、あとで巻き戻せる。',
    allow='allow（許可）', allow_sub='そのまま実行',
    hold='require_approval（承認待ち）', hold_sub='あなたが許可するまで保留',
    block='block（ブロック）', block_sub='拒否し、理由を記録',
)

os.makedirs(ASSETS, exist_ok=True)
draw_diagram(os.path.join(ASSETS, 'agentsgate-pipeline.png'), EN)
draw_diagram(os.path.join(ASSETS, 'agentsgate-pipeline-jp.png'), JA)
