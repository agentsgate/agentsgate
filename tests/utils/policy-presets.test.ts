/**
 * T133 — Policy preset library.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRESETS, PRESET_NAMES, getPreset } from '../../src/utils/policy-presets.js';
import { loadPolicy, savePolicy } from '../../src/policy.js';

describe('preset registry', () => {
  it('contains strict, permissive, readonly', () => {
    expect(PRESET_NAMES).toContain('strict');
    expect(PRESET_NAMES).toContain('permissive');
    expect(PRESET_NAMES).toContain('readonly');
  });

  it('getPreset returns undefined for unknown names', () => {
    expect(getPreset('nonexistent')).toBeUndefined();
  });

  it('getPreset is case-insensitive', () => {
    expect(getPreset('STRICT')).toBeDefined();
    expect(getPreset('Readonly')).toBeDefined();
  });

  it('each preset has at least one rule and defined thresholds', () => {
    for (const name of PRESET_NAMES) {
      const p = PRESETS[name];
      expect(p.rules.length).toBeGreaterThan(0);
      expect(p.thresholds).toBeDefined();
      expect(p.thresholds!.allowBelow).toBeDefined();
      expect(p.thresholds!.blockAtOrAbove).toBeDefined();
    }
  });

  it('strict is more restrictive than permissive', () => {
    const strict = getPreset('strict')!;
    const permissive = getPreset('permissive')!;
    expect(strict.thresholds!.blockAtOrAbove!).toBeLessThan(permissive.thresholds!.blockAtOrAbove!);
    expect(strict.thresholds!.allowBelow!).toBeLessThan(permissive.thresholds!.allowBelow!);
  });

  it('readonly preset blocks writes and shell tools', () => {
    const readonly = getPreset('readonly')!;
    const blockRules = readonly.rules.filter(r => r.action === 'block');
    expect(blockRules.length).toBeGreaterThan(0);
    // All readonly rules must block (no allow or require_approval)
    expect(readonly.rules.every(r => r.action === 'block')).toBe(true);
  });
});

describe('preset apply via savePolicy / loadPolicy', () => {
  let tmpDir: string;
  let policyPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preset-test-'));
    policyPath = path.join(tmpDir, 'policy.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saving a preset and loading it back yields the same rules', async () => {
    const preset = getPreset('strict')!;
    await savePolicy(preset, policyPath);
    const loaded = await loadPolicy(policyPath);
    expect(loaded.rules.length).toBe(preset.rules.length);
    expect(loaded.thresholds?.allowBelow).toBe(preset.thresholds!.allowBelow);
    expect(loaded.thresholds?.blockAtOrAbove).toBe(preset.thresholds!.blockAtOrAbove);
    for (let i = 0; i < preset.rules.length; i++) {
      expect(loaded.rules[i].id).toBe(preset.rules[i].id);
      expect(loaded.rules[i].action).toBe(preset.rules[i].action);
    }
  });

  it('preset overwrites existing rules when saved', async () => {
    // Write a custom policy first
    await savePolicy({ rules: [{ id: 'OLD_RULE', match: {} }] }, policyPath);
    // Apply permissive preset
    const preset = getPreset('permissive')!;
    await savePolicy(preset, policyPath);
    const loaded = await loadPolicy(policyPath);
    expect(loaded.rules.some(r => r.id === 'OLD_RULE')).toBe(false);
    expect(loaded.rules.every(r => preset.rules.some(p => p.id === r.id))).toBe(true);
  });
});
