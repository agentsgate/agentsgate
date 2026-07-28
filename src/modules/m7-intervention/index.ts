import type { RiskAssessment, ProxyDecision } from '../../types/interfaces.js';

/**
 * Thresholds for the intervention decision gate.
 * These are the defaults; they can be overridden per-instance via config.
 */
export interface InterventionThresholds {
  /** finalScore below this → allow */
  allowBelow: number;
  /** finalScore at or above this → block */
  blockAtOrAbove: number;
  // scores in [allowBelow, blockAtOrAbove) → require_approval
}

const DEFAULT_THRESHOLDS: InterventionThresholds = {
  allowBelow: 0.3,
  blockAtOrAbove: 0.7,
};

/**
 * M7: Intervention Controller
 * Translates a RiskAssessment into a binary ProxyDecision (allow / require_approval / block).
 *
 * Decision logic (using finalScore):
 *   score < 0.3            → allow
 *   0.3 ≤ score < 0.7      → require_approval
 *   score ≥ 0.7            → block
 */
export class InterventionController {
  private readonly thresholds: InterventionThresholds;

  constructor(thresholds: Partial<InterventionThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  async decide(
    assessment: RiskAssessment,
    checkpointId?: string
  ): Promise<ProxyDecision> {
    const score = assessment.finalScore;
    const { allowBelow, blockAtOrAbove } = this.thresholds;

    let action: ProxyDecision['action'];
    const reasons: string[] = [];

    if (score < allowBelow) {
      action = 'allow';
      reasons.push(`Risk score ${score.toFixed(2)} is below allow threshold (${allowBelow})`);
    } else if (score >= blockAtOrAbove) {
      action = 'block';
      reasons.push(`Risk score ${score.toFixed(2)} meets or exceeds block threshold (${blockAtOrAbove})`);
    } else {
      action = 'require_approval';
      reasons.push(`Risk score ${score.toFixed(2)} requires human approval (between ${allowBelow} and ${blockAtOrAbove})`);
    }

    // Surface triggered rules as additional reasons
    for (const rule of assessment.triggeredRules) {
      reasons.push(`Triggered rule: ${rule}`);
    }

    const decision: ProxyDecision = {
      action,
      riskScore: score,
      reasons,
    };

    if (checkpointId !== undefined) {
      decision.checkpointId = checkpointId;
    }

    return decision;
  }
}
