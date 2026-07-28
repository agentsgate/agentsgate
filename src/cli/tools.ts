import { parseFlag, readState, dashFetch } from './shared.js';

export async function cmdTools(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const tool = args.find(a => !a.startsWith('--'));
  if (tool) {
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/tools/${encodeURIComponent(tool)}`);
    if (status === 404) { console.error(`Tool not found: ${tool}`); process.exit(1); }
    const t = body as { tool: string; totalOps: number; byAction: { allow: number; block: number; require_approval: number }; avgRiskScore: number; maxRiskScore: number; allowRate?: number; pendingCount?: number; blockStreak?: number; highRiskCount?: number; mediumRiskCount?: number; lowRiskCount?: number; riskBuckets?: Record<string, number>; firstSeen?: string; lastSeen?: string; topAgents: Array<{ agentId: string; count: number }>; topSessions?: Array<{ sessionId: string; count: number }> };
    console.log(`Tool: ${t.tool}`);
    console.log(`  Total ops:  ${t.totalOps}  (allow ${t.byAction.allow} / block ${t.byAction.block} / approval ${t.byAction.require_approval})`);
    console.log(`  Avg risk:   ${(t.avgRiskScore * 100).toFixed(1)}%  max ${(t.maxRiskScore * 100).toFixed(1)}%`);
    if (t.allowRate !== undefined) console.log(`  Allow rate: ${(t.allowRate * 100).toFixed(1)}%`); // T445
    if (t.highRiskCount !== undefined) console.log(`  High risk (≥70%):  ${t.highRiskCount}`); // T475
    if (t.mediumRiskCount !== undefined) console.log(`  Med risk (30-70%): ${t.mediumRiskCount}`); // T475
    if (t.lowRiskCount !== undefined) console.log(`  Low risk (<30%):   ${t.lowRiskCount}`); // T475
    if (t.pendingCount !== undefined && t.pendingCount > 0) console.log(`  Pending:    ${t.pendingCount}`); // T445
    if (t.blockStreak !== undefined && t.blockStreak > 0) console.log(`  Block streak: ${t.blockStreak} consecutive`); // T445
    if (t.firstSeen) console.log(`  First seen: ${t.firstSeen}`); // T398
    if (t.lastSeen)  console.log(`  Last seen:  ${t.lastSeen}`);  // T398
    if (t.topAgents.length) {
      console.log(`  Top agents: ${t.topAgents.map(a => `${a.agentId}(${a.count})`).join(', ')}`);
    }
    if (t.topSessions && t.topSessions.length) { // T445
      console.log(`  Top sessions: ${t.topSessions.map(s => `${s.sessionId}(${s.count})`).join(', ')}`);
    }
    if (t.riskBuckets) { // T496: risk bucket distribution
      const bkts = Object.entries(t.riskBuckets).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`  Risk buckets: ${bkts}`);
    }
    const topSessByRisk = (t as Record<string, unknown>)['topSessionsByRisk'] as Array<{sessionId: string; avgRisk: number}> | undefined;
    if (topSessByRisk && topSessByRisk.length) { // T535
      console.log(`  Top risk sessions: ${topSessByRisk.map(s => `${s.sessionId.slice(0,12)}(${(s.avgRisk*100).toFixed(0)}%)`).join(', ')}`);
    }
    const topAgentsByRisk = (t as Record<string, unknown>)['topAgentsByRisk'] as Array<{agentId: string; avgRisk: number}> | undefined;
    if (topAgentsByRisk && topAgentsByRisk.length) { // T535
      console.log(`  Top risk agents: ${topAgentsByRisk.map(a => `${a.agentId.slice(0,12)}(${(a.avgRisk*100).toFixed(0)}%)`).join(', ')}`);
    }
    const tR1h = (t as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (tR1h !== undefined && tR1h !== null) console.log(`  Avg risk (1h):  ${(tR1h * 100).toFixed(1)}%`); // T561
    const tR24h = (t as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (tR24h !== undefined && tR24h !== null) console.log(`  Avg risk (24h): ${(tR24h * 100).toFixed(1)}%`); // T561
    const tBk24 = (t as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    const tBk1  = (t as Record<string, unknown>)['blockCountLast1h']  as number | undefined;
    if (tBk24 !== undefined) console.log(`  Blocks (24h):   ${tBk24}  (1h: ${tBk1 ?? 0})`); // T570
    const tAR = (t as Record<string, unknown>)['avgAllowRisk'] as number | null | undefined;
    const tBR = (t as Record<string, unknown>)['avgBlockRisk'] as number | null | undefined;
    if (tAR !== undefined && tAR !== null) console.log(`  Avg risk allow: ${(tAR * 100).toFixed(1)}%  block: ${tBR !== undefined && tBR !== null ? (tBR * 100).toFixed(1) + '%' : '—'}`); // T580
    const tPR = (t as Record<string, unknown>)['avgPendingRisk'] as number | null | undefined;
    if (tPR !== undefined && tPR !== null) console.log(`  Avg risk pending: ${(tPR * 100).toFixed(1)}%`); // T591
    const tSD = (t as Record<string, unknown>)['riskScoreStdDev'] as number | undefined;
    if (tSD !== undefined && tSD > 0) console.log(`  Risk std dev:    ${(tSD * 100).toFixed(1)}%`); // T592
    const tOR = (t as Record<string, unknown>)['operationRate'] as number | undefined;
    if (tOR !== undefined) console.log(`  Op rate (24h):   ${tOR.toFixed(3)} ops/min`); // T597
    const tP25 = (t as Record<string, unknown>)['p25RiskScore'] as number | undefined;
    const tIQR = (t as Record<string, unknown>)['interquartileRange'] as number | undefined;
    if (tP25 !== undefined) console.log(`  p25 risk:        ${(tP25 * 100).toFixed(1)}%${tIQR !== undefined ? `  IQR: ${(tIQR * 100).toFixed(1)}%` : ''}`); // T606
    const tSkew = (t as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (tSkew !== undefined && tSkew !== null) console.log(`  Risk skewness:   ${tSkew.toFixed(3)}`); // T612
    const tConc = (t as Record<string, unknown>)['riskConcentration'] as number | null | undefined;
    if (tConc !== undefined && tConc !== null) console.log(`  Risk concentration: ${(tConc * 100).toFixed(1)}% (top 20% ops)`); // T616
    const tHRR = (t as Record<string, unknown>)['highRiskRate'] as number | undefined;
    const tMRR = (t as Record<string, unknown>)['mediumRiskRate'] as number | undefined;
    const tLRR = (t as Record<string, unknown>)['lowRiskRate'] as number | undefined;
    if (tHRR !== undefined) console.log(`  Risk tiers:      H:${(tHRR*100).toFixed(1)}%${tMRR!==undefined?` M:${(tMRR*100).toFixed(1)}%`:''}${tLRR!==undefined?` L:${(tLRR*100).toFixed(1)}%`:''}`); // T636-T639
    const tRV = (t as Record<string, unknown>)['riskVelocity'] as number | null | undefined;
    if (tRV !== undefined && tRV !== null) console.log(`  Risk velocity:   ${tRV >= 0 ? '+' : ''}${(tRV * 100).toFixed(2)}% (1h delta)`); // T618
    const tBV = (t as Record<string, unknown>)['blockVelocity'] as number | null | undefined;
    if (tBV !== undefined && tBV !== null) console.log(`  Block velocity:  ${tBV >= 0 ? '+' : ''}${tBV} (1h delta)`); // T619
    const tTRO = (t as Record<string, unknown>)['topRiskOps'] as Array<Record<string, unknown>> | undefined;
    if (tTRO && tTRO.length > 0) { // T621
      console.log(`  Top risk ops:    ${tTRO.slice(0, 3).map(o => `${o['agentId']}:${((o['riskScore'] as number)*100).toFixed(0)}%`).join(', ')}`);
    }
    const tTMBC = (t as Record<string, unknown>)['topMethodsByBlockCount'] as Array<{method: string; blocked: number}> | undefined;
    if (tTMBC && tTMBC.length > 0) console.log(`  Top blocked methods: ${tTMBC.slice(0,3).map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T642
    const tHourly = (t as Record<string, unknown>)['avgRiskByHour'] as Array<number | null> | undefined;
    if (tHourly && tHourly.some(v => v !== null)) { // T624
      const spark = tHourly.slice(0, 12).map(v => v === null ? '·' : v >= 0.7 ? '█' : v >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Risk/hr sparkline: ${spark} (last 12h, newest left)`);
    }
    const tCBRT = (t as Record<string, unknown>)['consecutiveBlockRatio'] as number | undefined;
    if (tCBRT !== undefined && tCBRT > 0) console.log(`  Consec block ratio: ${(tCBRT * 100).toFixed(1)}%`); // T659
    const tRAcc = (t as Record<string, unknown>)['riskAcceleration'] as number | null | undefined;
    if (tRAcc !== null && tRAcc !== undefined) console.log(`  Risk acceleration:  ${tRAcc >= 0 ? '+' : ''}${(tRAcc * 100).toFixed(1)}%`); // T660
    const tMSR = (t as Record<string, unknown>)['methodSwitchRate'] as number | null | undefined;
    if (tMSR !== null && tMSR !== undefined) console.log(`  Method switch rate: ${(tMSR * 100).toFixed(1)}%`); // T663
    const tPOPM = (t as Record<string, unknown>)['peakOpsPerMinute'] as number | undefined;
    if (tPOPM !== undefined && tPOPM > 0) console.log(`  Peak ops/min:       ${tPOPM.toFixed(2)}`); // T662
    const tRASc = (t as Record<string, unknown>)['riskAnomalyScore'] as number | null | undefined;
    if (tRASc !== null && tRASc !== undefined) console.log(`  Risk anomaly (z):   ${tRASc >= 0 ? '+' : ''}${tRASc.toFixed(2)}`); // T664
    const tBRL = (t as Record<string, unknown>)['blockRunLengths'] as Record<string, number> | undefined;
    if (tBRL && Object.values(tBRL).some(v => v > 0)) { const parts = Object.entries(tBRL).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Block run lengths:  ${parts}`); } // T665
    const tATBO = (t as Record<string, unknown>)['avgTimeBetweenOps'] as number | null | undefined;
    if (tATBO !== null && tATBO !== undefined) console.log(`  Avg time bet. ops:  ${(tATBO / 1000).toFixed(1)}s`); // T666
    const tIR = (t as Record<string, unknown>)['idleRatio'] as number | undefined;
    if (tIR !== undefined) console.log(`  Idle ratio (24h):   ${(tIR * 100).toFixed(0)}%`); // T668
    const tRP = (t as Record<string, unknown>)['riskProfile'] as string | undefined;
    if (tRP) console.log(`  Risk profile:       ${tRP.toUpperCase()}`); // T669
    const tBBS = (t as Record<string, unknown>)['blockBurstScore'] as number | undefined;
    if (tBBS !== undefined && tBBS > 0) console.log(`  Block burst score:  ${(tBBS * 100).toFixed(1)}%`); // T670
    const tPST = (t as Record<string, unknown>)['pendingStreak'] as number | undefined;
    if (tPST !== undefined && tPST > 0) console.log(`  Pending streak:     ${tPST}`); // T671
    const tRSC = (t as Record<string, unknown>)['riskSkewnessCategory'] as string | null | undefined;
    if (tRSC) console.log(`  Risk skew:          ${tRSC}`); // T673
    const tHRMC = (t as Record<string, unknown>)['highRiskMethodCount'] as number | undefined;
    if (tHRMC !== undefined && tHRMC > 0) console.log(`  High-risk methods:  ${tHRMC}`); // T678
    const tOBS = (t as Record<string, unknown>)['opsBySeverity'] as {critical: number; high: number; medium: number; low: number} | undefined;
    if (tOBS) console.log(`  Ops by severity:    crit=${tOBS.critical} high=${tOBS.high} med=${tOBS.medium} low=${tOBS.low}`); // T676
    const tRTS = (t as Record<string, unknown>)['riskTrendSlope'] as number | null | undefined;
    if (tRTS !== null && tRTS !== undefined) console.log(`  Risk trend slope:   ${tRTS >= 0 ? '+' : ''}${tRTS.toFixed(4)}`); // T679
    const tARL30 = (t as Record<string, unknown>)['avgRiskLast30m'] as number | null | undefined;
    if (tARL30 !== null && tARL30 !== undefined) console.log(`  Avg risk (30m):     ${(tARL30 * 100).toFixed(1)}%`); // T680
    const tRBM = (t as Record<string, unknown>)['recentBlockedMethods'] as Array<{method: string; blocked: number}> | undefined;
    if (tRBM && tRBM.length > 0) console.log(`  Recent blk methods: ${tRBM.map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T681
    const tUMC = (t as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (tUMC !== undefined) console.log(`  Unique methods:     ${tUMC}`); // T686
    const tTABR = (t as Record<string, unknown>)['topAgentsByBlockRate'] as Array<{agentId: string; blockRate: number}> | undefined;
    if (tTABR && tTABR.length > 0) console.log(`  Top block-rate agents: ${tTABR.slice(0,3).map(a => `${a.agentId.slice(0,12)}(${(a.blockRate*100).toFixed(0)}%)`).join(', ')}`); // T684
    const tMRST = (t as Record<string, unknown>)['maxRiskStreak'] as number | undefined;
    if (tMRST !== undefined && tMRST > 0) console.log(`  Max risk streak:    ${tMRST}`); // T690
    const tP99 = (t as Record<string, unknown>)['p99RiskScore'] as number | undefined;
    if (tP99 !== undefined) console.log(`  p99 risk:           ${(tP99 * 100).toFixed(1)}%`); // T691
    const tROL5 = (t as Record<string, unknown>)['recentOpsLast5m'] as number | undefined;
    if (tROL5 !== undefined) console.log(`  Ops last 5m:        ${tROL5}`); // T692
    const tAL = (t as Record<string, unknown>)['alertLevel'] as string | undefined;
    if (tAL) console.log(`  Alert level:        ${tAL.toUpperCase()}`); // T694
    const tBRC = (t as Record<string, unknown>)['blockRateChange'] as number | null | undefined;
    if (tBRC != null) console.log(`  Block rate change:  ${tBRC >= 0 ? '+' : ''}${(tBRC * 100).toFixed(1)}%`); // T695
    const tARC = (t as Record<string, unknown>)['avgRiskChange'] as number | null | undefined;
    if (tARC != null) console.log(`  Avg risk change:    ${tARC >= 0 ? '+' : ''}${(tARC * 100).toFixed(1)}%`); // T696
    const tFHBR = (t as Record<string, unknown>)['firstHalfBlockRate'] as number | null | undefined;
    const tSHBR = (t as Record<string, unknown>)['secondHalfBlockRate'] as number | null | undefined;
    if (tFHBR != null && tSHBR != null) console.log(`  Block rate halves:  ${(tFHBR*100).toFixed(1)}% → ${(tSHBR*100).toFixed(1)}%`); // T697
    const tTRWS = (t as Record<string, unknown>)['topRiskWindowStart'] as string | null | undefined;
    if (tTRWS) console.log(`  Peak risk window:   ${new Date(tTRWS).toLocaleTimeString()}`); // T698
    const tOT24 = (t as Record<string, unknown>)['opsTrend24h'] as number[] | undefined;
    if (tOT24) console.log(`  Ops last 24h:       ${tOT24.reduce((a, b) => a + b, 0)} (peak/h: ${Math.max(...tOT24)})`); // T699
    const tBT24 = (t as Record<string, unknown>)['blockTrend24h'] as number[] | undefined;
    if (tBT24) console.log(`  Blocks last 24h:    ${tBT24.reduce((a, b) => a + b, 0)}`); // T700
    const tRT24 = (t as Record<string, unknown>)['avgRiskTrend24h'] as Array<number | null> | undefined;
    if (tRT24) { const vals = tRT24.filter((v): v is number => v !== null); if (vals.length > 0) console.log(`  Avg risk 24h:       ${(vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1)}%`); } // T701
    const tMD = (t as Record<string, unknown>)['methodDiversity'] as number | undefined;
    if (tMD !== undefined) console.log(`  Method diversity:   ${tMD.toFixed(3)}`); // T702
    const tAD = (t as Record<string, unknown>)['agentDiversity'] as number | undefined;
    if (tAD !== undefined) console.log(`  Agent diversity:    ${tAD.toFixed(3)}`); // T703
    const tHRH = (t as Record<string, unknown>)['highRiskHourCount'] as number | undefined;
    if (tHRH !== undefined && tHRH > 0) console.log(`  High-risk hours:    ${tHRH}/24`); // T704
    const tZOH = (t as Record<string, unknown>)['zeroOpsHourCount'] as number | undefined;
    if (tZOH !== undefined) console.log(`  Zero-ops hours:     ${tZOH}/24`); // T705
    const tBSH = (t as Record<string, unknown>)['blockSpikeHour'] as number | null | undefined;
    if (tBSH != null) console.log(`  Block spike hour:   ${tBSH} hrs ago`); // T706
    const tOSH = (t as Record<string, unknown>)['opsSpikeHour'] as number | null | undefined;
    if (tOSH != null) console.log(`  Ops spike hour:     ${tOSH} hrs ago`); // T707
    const tRV_b = (t as Record<string, unknown>)['riskVolatility'] as number | null | undefined;
    if (tRV_b != null) console.log(`  Risk volatility:    ${(tRV_b * 100).toFixed(1)}%`); // T708
    const tCOC = (t as Record<string, unknown>)['criticalOpsCount'] as number | undefined;
    if (tCOC !== undefined && tCOC > 0) console.log(`  Critical ops (≥0.9): ${tCOC}`); // T709
    const tARBA = (t as Record<string, unknown>)['avgRiskByAction'] as Record<string, number> | undefined;
    if (tARBA) console.log(`  Avg risk by action: allow=${(tARBA['allow']!*100).toFixed(0)}% block=${(tARBA['block']!*100).toFixed(0)}% pending=${(tARBA['require_approval']!*100).toFixed(0)}%`); // T710
    const tRAI = (t as Record<string, unknown>)['recentAgentIds'] as string[] | undefined;
    if (tRAI && tRAI.length > 0) console.log(`  Recent agents:      ${tRAI.slice(0,3).join(', ')}`); // T711
    const tRSI = (t as Record<string, unknown>)['recentSessionIds'] as string[] | undefined;
    if (tRSI && tRSI.length > 0) console.log(`  Recent sessions:    ${tRSI.slice(0,3).map(s => s.slice(0,12)).join(', ')}`); // T712
    const tOD = (t as Record<string, unknown>)['opsDensity'] as number | null | undefined;
    if (tOD != null) console.log(`  Ops density:        ${tOD.toFixed(1)}/h`); // T713
    const tBFS = (t as Record<string, unknown>)['blockFreeStreak'] as number | undefined;
    if (tBFS != null && tBFS > 0) console.log(`  Block-free streak:  ${tBFS} ops`); // T714
    const tHRFS = (t as Record<string, unknown>)['highRiskFreeStreak'] as number | undefined;
    if (tHRFS != null && tHRFS > 0) console.log(`  Low-risk streak:    ${tHRFS} ops`); // T715
    const tAOBB = (t as Record<string, unknown>)['avgOpsBetweenBlocks'] as number | null | undefined;
    if (tAOBB != null) console.log(`  Avg ops/block gap:  ${tAOBB.toFixed(1)}`); // T716
    const tRRT = (t as Record<string, unknown>)['recentRiskTrend'] as string | undefined;
    if (tRRT) console.log(`  Recent risk trend:  ${tRRT}`); // T717
    const tCS = (t as Record<string, unknown>)['coverageScore'] as number | undefined;
    if (tCS != null) console.log(`  24h coverage:       ${(tCS * 100).toFixed(0)}%`); // T718
    const tPHOD = (t as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (tPHOD != null) console.log(`  Peak hour:          h-${tPHOD}`); // T719
    const tQHOD = (t as Record<string, unknown>)['quietHourOfDay'] as number | null | undefined;
    if (tQHOD != null) console.log(`  Quiet hour:         h-${tQHOD}`); // T720
    const tBRL_b = (t as Record<string, unknown>)['blockRunLengthMax'] as number | undefined;
    if (tBRL_b != null && tBRL_b > 0) console.log(`  Max block run:      ${tBRL_b}`); // T721
    const tARL = (t as Record<string, unknown>)['allowRunLengthMax'] as number | undefined;
    if (tARL != null && tARL > 0) console.log(`  Max allow run:      ${tARL}`); // T722
    const tRIQR = (t as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (tRIQR != null) console.log(`  Risk IQR:           ${tRIQR.toFixed(3)}`); // T723
    const tMR = (t as Record<string, unknown>)['medianRisk'] as number | null | undefined;
    if (tMR != null) console.log(`  Median risk:        ${tMR.toFixed(3)}`); // T724
    const tP90 = (t as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (tP90 != null) console.log(`  P90 risk:           ${tP90.toFixed(3)}`); // T725
    const tBRLH = (t as Record<string, unknown>)['blockRateLastHour'] as number | null | undefined;
    if (tBRLH != null) console.log(`  Block rate (1h):    ${(tBRLH * 100).toFixed(1)}%`); // T726
    const tARLH = (t as Record<string, unknown>)['approvalRateLastHour'] as number | null | undefined;
    if (tARLH != null) console.log(`  Approval rate (1h): ${(tARLH * 100).toFixed(1)}%`); // T727
    const tUAC = (t as Record<string, unknown>)['uniqueAgentCount'] as number | undefined;
    if (tUAC != null) console.log(`  Unique agents:      ${tUAC}`); // T728
    const tRSD = (t as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (tRSD != null) console.log(`  Risk std dev:       ${tRSD.toFixed(3)}`); // T729
    const tFOT = (t as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (tFOT) console.log(`  First op:           ${tFOT}`); // T730
    const tLOT = (t as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (tLOT) console.log(`  Last op:            ${tLOT}`); // T731
    const tTBM = (t as Record<string, unknown>)['topBlockedMethod'] as string | null | undefined;
    if (tTBM) console.log(`  Top blocked method: ${tTBM}`); // T732
    const tARL10 = (t as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (tARL10 != null) console.log(`  Avg risk (last 10): ${tARL10.toFixed(3)}`); // T733
    const tBRLD = (t as Record<string, unknown>)['blockRateLastDay'] as number | null | undefined;
    if (tBRLD != null) console.log(`  Block rate (24h):   ${(tBRLD * 100).toFixed(1)}%`); // T734
    const tTAM = (t as Record<string, unknown>)['topAllowedMethod'] as string | null | undefined;
    if (tTAM) console.log(`  Top allowed method: ${tTAM}`); // T735
    const tRBOI = (t as Record<string, unknown>)['recentBlockedOpIds'] as string[] | undefined;
    if (tRBOI && tRBOI.length > 0) console.log(`  Recent blocked ops: ${tRBOI.map(id => id.slice(0,8)).join(', ')}`); // T736
    const tRAOI = (t as Record<string, unknown>)['recentApprovedOpIds'] as string[] | undefined;
    if (tRAOI && tRAOI.length > 0) console.log(`  Recent pending ops: ${tRAOI.map(id => id.slice(0,8)).join(', ')}`); // T737
    const tSC = (t as Record<string, unknown>)['sessionCount'] as number | undefined;
    if (tSC != null) console.log(`  Distinct sessions:  ${tSC}`); // T738
    const tMinR = (t as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (tMinR != null) console.log(`  Min risk:           ${tMinR.toFixed(3)}`); // T739
    const tMaxR = (t as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (tMaxR != null) console.log(`  Max risk:           ${tMaxR.toFixed(3)}`); // T740
    const tARF10 = (t as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (tARF10 != null) console.log(`  Avg risk (first 10):${tARF10.toFixed(3)}`); // T741
    const tRDFL = (t as Record<string, unknown>)['riskDeltaFirstLast'] as number | null | undefined;
    if (tRDFL != null) console.log(`  Risk delta F→L:     ${tRDFL >= 0 ? '+' : ''}${tRDFL.toFixed(3)}`); // T742
    const tAM = (t as Record<string, unknown>)['activeMinutes'] as number | null | undefined;
    if (tAM != null) console.log(`  Active span:        ${tAM.toFixed(1)}m`); // T743
    const tRSkew = (t as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (tRSkew != null) console.log(`  Risk skewness:      ${tRSkew.toFixed(3)}`); // T744
    const tOB5 = (t as Record<string, unknown>)['opsBurst5m'] as number | undefined;
    if (tOB5 != null) console.log(`  Ops burst (5m):     ${tOB5}`); // T745
    const tBB5 = (t as Record<string, unknown>)['blockBurst5m'] as number | undefined;
    if (tBB5 != null && tBB5 > 0) console.log(`  Block burst (5m):   ${tBB5}`); // T746
    const tAIMs = (t as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (tAIMs != null) console.log(`  Avg interval:       ${(tAIMs/1000).toFixed(1)}s`); // T747
    const tLGMs = (t as Record<string, unknown>)['longestGapMs'] as number | null | undefined;
    if (tLGMs != null) console.log(`  Longest gap:        ${(tLGMs/1000).toFixed(1)}s`); // T748
    const tKurt = (t as Record<string, unknown>)['kurtosis'] as number | null | undefined;
    if (tKurt != null) console.log(`  Kurtosis:           ${tKurt.toFixed(3)}`); // T749
    const tCHRM = (t as Record<string, unknown>)['consecutiveHighRiskMax'] as number | undefined;
    if (tCHRM != null && tCHRM > 0) console.log(`  Max hi-risk streak: ${tCHRM}`); // T753
    const tCLRM = (t as Record<string, unknown>)['consecutiveLowRiskMax'] as number | undefined;
    if (tCLRM != null && tCLRM > 0) console.log(`  Max lo-risk streak: ${tCLRM}`); // T751
    const tRBF = (t as Record<string, unknown>)['riskBucketsFine'] as number[] | undefined;
    if (tRBF && tRBF.some(v => v > 0)) console.log(`  Risk buckets(fine): ${tRBF.join('|')}`); // T752
    const tRWBR = (t as Record<string, unknown>)['riskWeightedBlockRate'] as number | null | undefined;
    if (tRWBR != null) console.log(`  Risk-wtd blk rate:  ${(tRWBR*100).toFixed(1)}%`); // T754
    const tAPC = (t as Record<string, unknown>)['approvalPendingCount'] as number | undefined;
    if (tAPC != null && tAPC > 0) console.log(`  Pending approvals:  ${tAPC}`); // T755
    const tTMBO = (t as Record<string, unknown>)['topMethodByOps'] as string | null | undefined;
    if (tTMBO) console.log(`  Top method (ops):   ${tTMBO}`); // T756
    const tTMBR = (t as Record<string, unknown>)['topMethodByRisk'] as string | null | undefined;
    if (tTMBR) console.log(`  Top method (risk):  ${tTMBR}`); // T757
    const tR99 = (t as Record<string, unknown>)['riskScore99p'] as number | null | undefined;
    if (tR99 != null) console.log(`  P99 risk:           ${tR99.toFixed(3)}`); // T758
    const tUMC_b = (t as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (tUMC_b != null) console.log(`  Unique methods:     ${tUMC_b}`); // T759
    const tR10 = (t as Record<string, unknown>)['riskScore10p'] as number | null | undefined;
    if (tR10 != null) console.log(`  P10 risk:           ${tR10.toFixed(3)}`); // T762
    const tR75 = (t as Record<string, unknown>)['riskScore75p'] as number | null | undefined;
    if (tR75 != null) console.log(`  P75 risk:           ${tR75.toFixed(3)}`); // T763
    const tR25 = (t as Record<string, unknown>)['riskScore25p'] as number | null | undefined;
    if (tR25 != null) console.log(`  P25 risk:           ${tR25.toFixed(3)}`); // T766
    const tREB = (t as Record<string, unknown>)['riskEntropyBuckets'] as number | undefined;
    if (tREB != null) console.log(`  Risk entropy:       ${tREB.toFixed(3)}`); // T767
    const tARA = (t as Record<string, unknown>)['avgRiskByAgent'] as Record<string, number> | undefined;
    if (tARA && Object.keys(tARA).length > 0) { const top3 = Object.entries(tARA).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${(v*100).toFixed(0)}%`).join(' '); console.log(`  Avg risk/agent:     ${top3}`); } // T768
    const tBCA = (t as Record<string, unknown>)['blockCountByAgent'] as Record<string, number> | undefined;
    if (tBCA && Object.keys(tBCA).length > 0) { const top3 = Object.entries(tBCA).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Blocks/agent:       ${top3}`); } // T769
    const tACA = (t as Record<string, unknown>)['allowCountByAgent'] as Record<string, number> | undefined;
    if (tACA && Object.keys(tACA).length > 0) { const top3 = Object.entries(tACA).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Allows/agent:       ${top3}`); } // T770
    const tOL5 = (t as Record<string, unknown>)['opsLast5m'] as number | undefined;
    if (tOL5 != null) console.log(`  Ops last 5m:        ${tOL5}`); // T771
    const tBL5 = (t as Record<string, unknown>)['blocksLast5m'] as number | undefined;
    if (tBL5 != null) console.log(`  Blocks last 5m:     ${tBL5}`); // T772
    const tHRI = (t as Record<string, unknown>)['highRiskOpIds'] as string[] | undefined;
    if (tHRI && tHRI.length > 0) console.log(`  High risk op IDs:   ${tHRI.slice(0, 3).join(' ')}`); // T773
    const tARP = (t as Record<string, unknown>)['approvalRatePercent'] as number | null | undefined;
    if (tARP != null) console.log(`  Approval rate:      ${tARP.toFixed(1)}%`); // T774
    const tRCR = (t as Record<string, unknown>)['riskChangeRate'] as number | null | undefined;
    if (tRCR != null) console.log(`  Risk change rate:   ${tRCR.toFixed(3)}`); // T775
    const tDD = (t as Record<string, unknown>)['decisionDistribution'] as Record<string, number> | undefined;
    if (tDD) console.log(`  Decisions:          allow=${tDD['allow']} block=${tDD['block']} approval=${tDD['require_approval']}`); // T776
    const tOT = (t as Record<string, unknown>)['opsTrend12h'] as number | null | undefined;
    if (tOT != null) console.log(`  Ops trend 12h:      ${tOT.toFixed(2)}x`); // T777
    const tARB = (t as Record<string, unknown>)['avgRiskOfBlocked'] as number | null | undefined;
    if (tARB != null) console.log(`  Avg risk blocked:   ${tARB.toFixed(3)}`); // T778
    const tARA_b = (t as Record<string, unknown>)['avgRiskOfAllowed'] as number | null | undefined;
    if (tARA_b != null) console.log(`  Avg risk allowed:   ${tARA_b.toFixed(3)}`); // T779
    const tRGB = (t as Record<string, unknown>)['riskGapBlockVsAllow'] as number | null | undefined;
    if (tRGB != null) console.log(`  Risk gap b-a:       ${tRGB.toFixed(3)}`); // T780
    const tOL1 = (t as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (tOL1 != null) console.log(`  Ops last 1h:        ${tOL1}`); // T781
    const tBL1 = (t as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (tBL1 != null) console.log(`  Blocks last 1h:     ${tBL1}`); // T782
    const tBRO = (t as Record<string, unknown>)['blockRateOverall'] as number | null | undefined;
    if (tBRO != null) console.log(`  Block rate overall: ${(tBRO*100).toFixed(1)}%`); // T783
    const tARO = (t as Record<string, unknown>)['allowRateOverall'] as number | null | undefined;
    if (tARO != null) console.log(`  Allow rate overall: ${(tARO*100).toFixed(1)}%`); // T784
    const tACO = (t as Record<string, unknown>)['approvalCountOverall'] as number | undefined;
    if (tACO != null) console.log(`  Approval count:     ${tACO}`); // T785
    const tRB = (t as Record<string, unknown>)['riskBand'] as string | undefined;
    if (tRB) console.log(`  Risk band:          ${tRB}`); // T786
    const tRAI_b = (t as Record<string, unknown>)['recentAllowedOpIds'] as string[] | undefined;
    if (tRAI_b && tRAI_b.length > 0) console.log(`  Recent allow IDs:   ${tRAI_b.slice(0, 3).join(' ')}`); // T787
    const tP95 = (t as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (tP95 != null) console.log(`  P95 risk:           ${tP95.toFixed(3)}`); // T788
    const tRCV = (t as Record<string, unknown>)['riskCV'] as number | null | undefined;
    if (tRCV != null) console.log(`  Risk CV:            ${tRCV.toFixed(3)}`); // T789
    const tBSC = (t as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (tBSC != null && tBSC > 0) console.log(`  Block streak now:   ${tBSC}`); // T790
    const tASC = (t as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (tASC != null && tASC > 0) console.log(`  Allow streak now:   ${tASC}`); // T791
    const tRM = (t as Record<string, unknown>)['riskMomentum'] as number | null | undefined;
    if (tRM != null) console.log(`  Risk momentum:      ${tRM.toFixed(3)}`); // T792
    const tOPA = (t as Record<string, unknown>)['opsPerAgent'] as number | null | undefined;
    if (tOPA != null) console.log(`  Ops per agent:      ${tOPA.toFixed(1)}`); // T793
    const tOPT = (t as Record<string, unknown>)['opsPerTool'] as number | null | undefined;
    if (tOPT != null) console.log(`  Ops per tool:       ${tOPT.toFixed(1)}`); // T794
    const tHRBC = (t as Record<string, unknown>)['highRiskBlockCount'] as number | undefined;
    if (tHRBC != null) console.log(`  High-risk blocks:   ${tHRBC}`); // T796
    const tLRAC = (t as Record<string, unknown>)['lowRiskAllowCount'] as number | undefined;
    if (tLRAC != null) console.log(`  Low-risk allows:    ${tLRAC}`); // T797
    const tRTHD = (t as Record<string, unknown>)['riskTrendHalfDay'] as number | null | undefined;
    if (tRTHD != null) console.log(`  Risk trend 12h:     ${tRTHD > 0 ? '+' : ''}${tRTHD.toFixed(3)}`); // T798
    const tMIM = (t as Record<string, unknown>)['medianIntervalMs'] as number | null | undefined;
    if (tMIM != null) console.log(`  Median interval:    ${tMIM.toFixed(0)}ms`); // T799
    const tBRL6 = (t as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (tBRL6 != null) console.log(`  Block rate 6h:      ${(tBRL6*100).toFixed(1)}%`); // T800
    const tARL6 = (t as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (tARL6 != null) console.log(`  Allow rate 6h:      ${(tARL6*100).toFixed(1)}%`); // T801
    const tRDS = (t as Record<string, unknown>)['riskDecayScore'] as number | null | undefined;
    if (tRDS != null) console.log(`  Risk decay score:   ${tRDS.toFixed(3)}`); // T802
    const tROI = (t as Record<string, unknown>)['recentOpIds'] as string[] | undefined;
    if (tROI && tROI.length > 0) console.log(`  Recent op IDs:      ${tROI.slice(0, 3).join(' ')}`); // T803
    const tBRL3 = (t as Record<string, unknown>)['blockRateLast3h'] as number | null | undefined;
    if (tBRL3 != null) console.log(`  Block rate 3h:      ${(tBRL3*100).toFixed(1)}%`); // T804
    const tARL3 = (t as Record<string, unknown>)['allowRateLast3h'] as number | null | undefined;
    if (tARL3 != null) console.log(`  Allow rate 3h:      ${(tARL3*100).toFixed(1)}%`); // T805
    const tOL3 = (t as Record<string, unknown>)['opsLast3h'] as number | undefined;
    if (tOL3 != null) console.log(`  Ops last 3h:        ${tOL3}`); // T806
    const tTABO = (t as Record<string, unknown>)['topAgentByOps'] as string | null | undefined;
    if (tTABO) console.log(`  Top agent (ops):    ${tTABO}`); // T807
    const tTABR_b = (t as Record<string, unknown>)['topAgentByRisk'] as string | null | undefined;
    if (tTABR_b) console.log(`  Top agent (risk):   ${tTABR_b}`); // T808
    const tTTBO = (t as Record<string, unknown>)['topToolByOps'] as string | null | undefined;
    if (tTTBO) console.log(`  Top tool (ops):     ${tTTBO}`); // T809
    const tTTBR = (t as Record<string, unknown>)['topToolByRisk'] as string | null | undefined;
    if (tTTBR) console.log(`  Top tool (risk):    ${tTTBR}`); // T810
    const tBCL24 = (t as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (tBCL24 != null) console.log(`  Blocks last 24h:    ${tBCL24}`); // T811
    const tACL24 = (t as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (tACL24 != null) console.log(`  Allows last 24h:    ${tACL24}`); // T812
    const tAPCL24 = (t as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (tAPCL24 != null) console.log(`  Approvals last 24h: ${tAPCL24}`); // T813
    const tRAMC = (t as Record<string, unknown>)['riskAboveMedianCount'] as number | undefined;
    if (tRAMC != null) console.log(`  Risk above median:  ${tRAMC}`); // T814
    const tRBMC = (t as Record<string, unknown>)['riskBelowMedianCount'] as number | undefined;
    if (tRBMC != null) console.log(`  Risk below median:  ${tRBMC}`); // T815
    const tBD = (t as Record<string, unknown>)['blockDensity'] as number | null | undefined;
    if (tBD != null) console.log(`  Block density:      ${tBD.toFixed(1)}/1k`); // T816
    const tAD_b = (t as Record<string, unknown>)['approvalDensity'] as number | null | undefined;
    if (tAD_b != null) console.log(`  Approval density:   ${tAD_b.toFixed(1)}/1k`); // T817
    const tRVR = (t as Record<string, unknown>)['riskVolatilityRecent'] as number | null | undefined;
    if (tRVR != null) console.log(`  Risk vol (recent):  ${tRVR.toFixed(3)}`); // T818
    const tRHBC = (t as Record<string, unknown>)['riskHighBandCount'] as number | undefined;
    if (tRHBC != null) console.log(`  Risk high (>=0.7):  ${tRHBC}`); // T819
    const tRLBC = (t as Record<string, unknown>)['riskLowBandCount'] as number | undefined;
    if (tRLBC != null) console.log(`  Risk low (<0.3):    ${tRLBC}`); // T820
    const tRMBC = (t as Record<string, unknown>)['riskMidBandCount'] as number | undefined;
    if (tRMBC != null) console.log(`  Risk mid (0.3-0.7): ${tRMBC}`); // T821
    const tHSFO = (t as Record<string, unknown>)['hoursSinceFirstOp'] as number | null | undefined;
    if (tHSFO != null) console.log(`  Hours since 1st op: ${tHSFO.toFixed(1)}`); // T822
    const tHSLO = (t as Record<string, unknown>)['hoursSinceLastOp'] as number | null | undefined;
    if (tHSLO != null) console.log(`  Hours since last op:${tHSLO.toFixed(1)}`); // T823
    const tOL30 = (t as Record<string, unknown>)['opsLast30m'] as number | undefined;
    if (tOL30 != null) console.log(`  Ops last 30m:       ${tOL30}`); // T824
    const tBL30 = (t as Record<string, unknown>)['blocksLast30m'] as number | undefined;
    if (tBL30 != null) console.log(`  Blocks last 30m:    ${tBL30}`); // T825
    const tTSO = (t as Record<string, unknown>)['topSessionByOps'] as string | null | undefined;
    if (tTSO != null) console.log(`  Top sess (ops):     ${tTSO}`); // T826
    const tTSR = (t as Record<string, unknown>)['topSessionByRisk'] as string | null | undefined;
    if (tTSR != null) console.log(`  Top sess (risk):    ${tTSR}`); // T827
    const tUSC = (t as Record<string, unknown>)['uniqueSessionCount'] as number | undefined;
    if (tUSC != null) console.log(`  Unique sessions:    ${tUSC}`); // T828
    const tUAC_b = (t as Record<string, unknown>)['uniqueAgentCount'] as number | undefined;
    if (tUAC_b != null) console.log(`  Unique agents:      ${tUAC_b}`); // T829
    const tUTC = (t as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
    if (tUTC != null) console.log(`  Unique tools:       ${tUTC}`); // T830
    const tAOS = (t as Record<string, unknown>)['avgOpsPerSession'] as number | null | undefined;
    if (tAOS != null) console.log(`  Avg ops/session:    ${tAOS.toFixed(1)}`); // T831
    const tTTB = (t as Record<string, unknown>)['topToolByBlocks'] as string | null | undefined;
    if (tTTB != null) console.log(`  Top tool (blocks):  ${tTTB}`); // T832
    const tTAB = (t as Record<string, unknown>)['topAgentByBlocks'] as string | null | undefined;
    if (tTAB != null) console.log(`  Top agent (blocks): ${tTAB}`); // T833
    const tBRL24 = (t as Record<string, unknown>)['blockRateLast24h'] as number | null | undefined;
    if (tBRL24 != null) console.log(`  Block rate 24h:     ${(tBRL24 * 100).toFixed(1)}%`); // T834
    const tARL24 = (t as Record<string, unknown>)['allowRateLast24h'] as number | null | undefined;
    if (tARL24 != null) console.log(`  Allow rate 24h:     ${(tARL24 * 100).toFixed(1)}%`); // T835
    const tAPRL24 = (t as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (tAPRL24 != null) console.log(`  Approval rate 24h:  ${(tAPRL24 * 100).toFixed(1)}%`); // T836
    const tMCB = (t as Record<string, unknown>)['maxConsecutiveBlocks'] as number | undefined;
    if (tMCB != null) console.log(`  Max consec blocks:  ${tMCB}`); // T837
    const tMCA = (t as Record<string, unknown>)['maxConsecutiveAllows'] as number | undefined;
    if (tMCA != null) console.log(`  Max consec allows:  ${tMCA}`); // T838
    const tRSK = (t as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (tRSK != null) console.log(`  Risk skewness:      ${tRSK.toFixed(3)}`); // T839
    const tRKT = (t as Record<string, unknown>)['riskKurtosis'] as number | null | undefined;
    if (tRKT != null) console.log(`  Risk kurtosis:      ${tRKT.toFixed(3)}`); // T840
    const tOL15 = (t as Record<string, unknown>)['opsLast15m'] as number | undefined;
    if (tOL15 != null) console.log(`  Ops last 15m:       ${tOL15}`); // T841
    const tBL15 = (t as Record<string, unknown>)['blocksLast15m'] as number | undefined;
    if (tBL15 != null) console.log(`  Blocks last 15m:    ${tBL15}`); // T842
    const tHRR_b = (t as Record<string, unknown>)['highRiskRateOverall'] as number | null | undefined;
    if (tHRR_b != null) console.log(`  High-risk rate:     ${(tHRR_b * 100).toFixed(1)}%`); // T843
    const tLRR_b = (t as Record<string, unknown>)['lowRiskRateOverall'] as number | null | undefined;
    if (tLRR_b != null) console.log(`  Low-risk rate:      ${(tLRR_b * 100).toFixed(1)}%`); // T844
    const tMRR_b = (t as Record<string, unknown>)['midRiskRateOverall'] as number | null | undefined;
    if (tMRR_b != null) console.log(`  Mid-risk rate:      ${(tMRR_b * 100).toFixed(1)}%`); // T845
    const tRRG = (t as Record<string, unknown>)['riskRange'] as number | null | undefined;
    if (tRRG != null) console.log(`  Risk range:         ${tRRG.toFixed(3)}`); // T846
    const tFOT_b = (t as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (tFOT_b != null) console.log(`  First op at:        ${tFOT_b}`); // T847
    const tLOT_b = (t as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (tLOT_b != null) console.log(`  Last op at:         ${tLOT_b}`); // T848
    const tTDMs = (t as Record<string, unknown>)['totalDurationMs'] as number | null | undefined;
    if (tTDMs != null) console.log(`  Total duration:     ${(tTDMs / 3600000).toFixed(1)}h`); // T849
    const tOPH = (t as Record<string, unknown>)['opsPerHour'] as number | null | undefined;
    if (tOPH != null) console.log(`  Ops per hour:       ${tOPH.toFixed(1)}`); // T850
    const tBPH = (t as Record<string, unknown>)['blocksPerHour'] as number | null | undefined;
    if (tBPH != null) console.log(`  Blocks per hour:    ${tBPH.toFixed(1)}`); // T851
    const tRWBC = (t as Record<string, unknown>)['riskWeightedBlockCount'] as number | undefined;
    if (tRWBC != null) console.log(`  Risk-wtd blocks:    ${tRWBC.toFixed(2)}`); // T852
    const tRWAC = (t as Record<string, unknown>)['riskWeightedAllowCount'] as number | undefined;
    if (tRWAC != null) console.log(`  Risk-wtd allows:    ${tRWAC.toFixed(2)}`); // T853
    const tARL10_b = (t as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (tARL10_b != null) console.log(`  Avg risk last 10:   ${tARL10_b.toFixed(3)}`); // T854
    const tARF10_b = (t as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (tARF10_b != null) console.log(`  Avg risk first 10:  ${tARF10_b.toFixed(3)}`); // T855
    const tRTF10 = (t as Record<string, unknown>)['riskTrendFirst10vsLast10'] as number | null | undefined;
    if (tRTF10 != null) console.log(`  Risk trend (10):    ${tRTF10 >= 0 ? '+' : ''}${tRTF10.toFixed(3)}`); // T856
    const tBCL7 = (t as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (tBCL7 != null) console.log(`  Blocks last 7d:     ${tBCL7}`); // T857
    const tACL7 = (t as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (tACL7 != null) console.log(`  Allows last 7d:     ${tACL7}`); // T858
    const tAPCL7 = (t as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (tAPCL7 != null) console.log(`  Approvals last 7d:  ${tAPCL7}`); // T859
    const tOCL7 = (t as Record<string, unknown>)['opsCountLast7d'] as number | undefined;
    if (tOCL7 != null) console.log(`  Ops last 7d:        ${tOCL7}`); // T860
    const tRSA = (t as Record<string, unknown>)['riskSumAll'] as number | undefined;
    if (tRSA != null) console.log(`  Risk sum (all):     ${tRSA.toFixed(2)}`); // T861
    const tAIM = (t as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (tAIM != null) console.log(`  Avg interval:       ${(tAIM / 1000).toFixed(1)}s`); // T862
    const tMNR = (t as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (tMNR != null) console.log(`  Min risk:           ${tMNR.toFixed(3)}`); // T863
    const tMXR = (t as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (tMXR != null) console.log(`  Max risk:           ${tMXR.toFixed(3)}`); // T864
    const tRIQR_b = (t as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (tRIQR_b != null) console.log(`  Risk IQR:           ${tRIQR_b.toFixed(3)}`); // T865
    const tBRC1 = (t as Record<string, unknown>)['blockRateChange1h'] as number | undefined;
    if (tBRC1 != null) console.log(`  Block rate Δ1h:     ${tBRC1 >= 0 ? '+' : ''}${(tBRC1 * 100).toFixed(1)}%`); // T866
    const tOT1 = (t as Record<string, unknown>)['opsTrend1h'] as number | null | undefined;
    if (tOT1 != null) console.log(`  Ops trend 1h:       ${tOT1.toFixed(2)}x`); // T867
    const tBT6 = (t as Record<string, unknown>)['blockTrend6h'] as number | null | undefined;
    if (tBT6 != null) console.log(`  Block trend 6h:     ${tBT6.toFixed(2)}x`); // T868
    const tAT6 = (t as Record<string, unknown>)['allowTrend6h'] as number | null | undefined;
    if (tAT6 != null) console.log(`  Allow trend 6h:     ${tAT6.toFixed(2)}x`); // T869
    const tBRA = (t as Record<string, unknown>)['blockRatioToAllow'] as number | null | undefined;
    if (tBRA != null) console.log(`  Block/allow ratio:  ${tBRA.toFixed(2)}`); // T870
    const tARB_b = (t as Record<string, unknown>)['approvalRatioToBlock'] as number | null | undefined;
    if (tARB_b != null) console.log(`  Approval/block:     ${tARB_b.toFixed(2)}`); // T871
    const tOL2 = (t as Record<string, unknown>)['opsLast2h'] as number | undefined;
    if (tOL2 != null) console.log(`  Ops last 2h:        ${tOL2}`); // T872
    const tBL2 = (t as Record<string, unknown>)['blocksLast2h'] as number | undefined;
    if (tBL2 != null) console.log(`  Blocks last 2h:     ${tBL2}`); // T873
    const tAL2 = (t as Record<string, unknown>)['allowsLast2h'] as number | undefined;
    if (tAL2 != null) console.log(`  Allows last 2h:     ${tAL2}`); // T874
    const tOL4 = (t as Record<string, unknown>)['opsLast4h'] as number | undefined;
    if (tOL4 != null) console.log(`  Ops last 4h:        ${tOL4}`); // T875
    const tBL4 = (t as Record<string, unknown>)['blocksLast4h'] as number | undefined;
    if (tBL4 != null) console.log(`  Blocks last 4h:     ${tBL4}`); // T876
    const tBR4 = (t as Record<string, unknown>)['blockRateLast4h'] as number | null | undefined;
    if (tBR4 != null) console.log(`  Block rate 4h:      ${(tBR4 * 100).toFixed(1)}%`); // T877
    const tRSD_b = (t as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (tRSD_b != null) console.log(`  Risk std dev:       ${tRSD_b.toFixed(3)}`); // T878
    const tAL4 = (t as Record<string, unknown>)['allowsLast4h'] as number | undefined;
    if (tAL4 != null) console.log(`  Allows last 4h:     ${tAL4}`); // T879
    const tAR4 = (t as Record<string, unknown>)['allowRateLast4h'] as number | null | undefined;
    if (tAR4 != null) console.log(`  Allow rate 4h:      ${(tAR4 * 100).toFixed(1)}%`); // T880
    const tOL12 = (t as Record<string, unknown>)['opsLast12h'] as number | undefined;
    if (tOL12 != null) console.log(`  Ops last 12h:       ${tOL12}`); // T881
    const tBL12 = (t as Record<string, unknown>)['blocksLast12h'] as number | undefined;
    if (tBL12 != null) console.log(`  Blocks last 12h:    ${tBL12}`); // T882
    const tAL12 = (t as Record<string, unknown>)['allowsLast12h'] as number | undefined;
    if (tAL12 != null) console.log(`  Allows last 12h:    ${tAL12}`); // T883
    const tBR12 = (t as Record<string, unknown>)['blockRateLast12h'] as number | null | undefined;
    if (tBR12 != null) console.log(`  Block rate 12h:     ${(tBR12 * 100).toFixed(1)}%`); // T884
    const tAR12 = (t as Record<string, unknown>)['allowRateLast12h'] as number | null | undefined;
    if (tAR12 != null) console.log(`  Allow rate 12h:     ${(tAR12 * 100).toFixed(1)}%`); // T885
    const tOL48 = (t as Record<string, unknown>)['opsLast48h'] as number | undefined;
    if (tOL48 != null) console.log(`  Ops last 48h:       ${tOL48}`); // T886
    const tBL48 = (t as Record<string, unknown>)['blocksLast48h'] as number | undefined;
    if (tBL48 != null) console.log(`  Blocks last 48h:    ${tBL48}`); // T887
    const tAL48 = (t as Record<string, unknown>)['allowsLast48h'] as number | undefined;
    if (tAL48 != null) console.log(`  Allows last 48h:    ${tAL48}`); // T888
    const tBR48 = (t as Record<string, unknown>)['blockRateLast48h'] as number | null | undefined;
    if (tBR48 != null) console.log(`  Block rate 48h:     ${(tBR48 * 100).toFixed(1)}%`); // T889
    const tAR48 = (t as Record<string, unknown>)['allowRateLast48h'] as number | null | undefined;
    if (tAR48 != null) console.log(`  Allow rate 48h:     ${(tAR48 * 100).toFixed(1)}%`); // T890
    const tAPC24 = (t as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (tAPC24 != null) console.log(`  Approvals last 24h: ${tAPC24}`); // T891
    const tAPR24 = (t as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (tAPR24 != null) console.log(`  Approval rate 24h:  ${(tAPR24 * 100).toFixed(1)}%`); // T892
    const tRCV_b = (t as Record<string, unknown>)['riskCvPct'] as number | null | undefined;
    if (tRCV_b != null) console.log(`  Risk CV%:           ${tRCV_b.toFixed(1)}%`); // T893
    const tAPC48 = (t as Record<string, unknown>)['approvalCountLast48h'] as number | undefined;
    if (tAPC48 != null) console.log(`  Approvals last 48h: ${tAPC48}`); // T894
    const tAPC12 = (t as Record<string, unknown>)['approvalCountLast12h'] as number | undefined;
    if (tAPC12 != null) console.log(`  Approvals last 12h: ${tAPC12}`); // T895
    const tP50 = (t as Record<string, unknown>)['p50Risk'] as number | null | undefined;
    if (tP50 != null) console.log(`  Risk p50:           ${tP50.toFixed(3)}`); // T896
    const tP90_b = (t as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (tP90_b != null) console.log(`  Risk p90:           ${tP90_b.toFixed(3)}`); // T897
    const tP10 = (t as Record<string, unknown>)['p10Risk'] as number | null | undefined;
    if (tP10 != null) console.log(`  Risk p10:           ${tP10.toFixed(3)}`); // T898
    const tBC30d = (t as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (tBC30d != null) console.log(`  Blocks last 30d:    ${tBC30d}`); // T899
    const tAC30d = (t as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (tAC30d != null) console.log(`  Allows last 30d:    ${tAC30d}`); // T900
    const tOL30d = (t as Record<string, unknown>)['opsLast30d'] as number | undefined;
    if (tOL30d != null) console.log(`  Ops last 30d:       ${tOL30d}`); // T901
    const tBR30d = (t as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (tBR30d != null) console.log(`  Block rate 30d:     ${(tBR30d * 100).toFixed(1)}%`); // T902
    const tAR30d = (t as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (tAR30d != null) console.log(`  Avg risk 30d:       ${tAR30d.toFixed(3)}`); // T903
    const tAPR48 = (t as Record<string, unknown>)['approvalRateLast48h'] as number | null | undefined;
    if (tAPR48 != null) console.log(`  Approval rate 48h:  ${(tAPR48 * 100).toFixed(1)}%`); // T904
    const tAPR12 = (t as Record<string, unknown>)['approvalRateLast12h'] as number | null | undefined;
    if (tAPR12 != null) console.log(`  Approval rate 12h:  ${(tAPR12 * 100).toFixed(1)}%`); // T905
    const tAPR30d = (t as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (tAPR30d != null) console.log(`  Approval rate 30d:  ${(tAPR30d * 100).toFixed(1)}%`); // T906
    const tHRC24 = (t as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (tHRC24 != null) console.log(`  High risk last 24h: ${tHRC24}`); // T907
    const tHRC7d = (t as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (tHRC7d != null) console.log(`  High risk last 7d:  ${tHRC7d}`); // T908
    const tHRC30d = (t as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (tHRC30d != null) console.log(`  High risk last 30d: ${tHRC30d}`); // T909
    const tLRC24 = (t as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (tLRC24 != null) console.log(`  Low risk last 24h:  ${tLRC24}`); // T910
    const tLRC7d = (t as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (tLRC7d != null) console.log(`  Low risk last 7d:   ${tLRC7d}`); // T911
    const tARL7d = (t as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (tARL7d != null) console.log(`  Avg risk 7d:        ${tARL7d.toFixed(3)}`); // T912
    const tARL24_b = (t as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (tARL24_b != null) console.log(`  Avg risk 24h:       ${tARL24_b.toFixed(3)}`); // T913
    const tARL48 = (t as Record<string, unknown>)['avgRiskLast48h'] as number | null | undefined;
    if (tARL48 != null) console.log(`  Avg risk 48h:       ${tARL48.toFixed(3)}`); // T914
    const tARL12 = (t as Record<string, unknown>)['avgRiskLast12h'] as number | null | undefined;
    if (tARL12 != null) console.log(`  Avg risk 12h:       ${tARL12.toFixed(3)}`); // T915
    const tLRC30d = (t as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (tLRC30d != null) console.log(`  Low risk last 30d:  ${tLRC30d}`); // T916
    const tLRC48 = (t as Record<string, unknown>)['lowRiskCountLast48h'] as number | undefined;
    if (tLRC48 != null) console.log(`  Low risk last 48h:  ${tLRC48}`); // T917
    const tLRC12 = (t as Record<string, unknown>)['lowRiskCountLast12h'] as number | undefined;
    if (tLRC12 != null) console.log(`  Low risk last 12h:  ${tLRC12}`); // T918
    const tHRC48 = (t as Record<string, unknown>)['highRiskCountLast48h'] as number | undefined;
    if (tHRC48 != null) console.log(`  High risk last 48h: ${tHRC48}`); // T919
    const tHRC12 = (t as Record<string, unknown>)['highRiskCountLast12h'] as number | undefined;
    if (tHRC12 != null) console.log(`  High risk last 12h: ${tHRC12}`); // T920
    const tMRC24 = (t as Record<string, unknown>)['midRiskCountLast24h'] as number | undefined;
    if (tMRC24 != null) console.log(`  Mid risk last 24h:  ${tMRC24}`); // T921
    const tMRC7d = (t as Record<string, unknown>)['midRiskCountLast7d'] as number | undefined;
    if (tMRC7d != null) console.log(`  Mid risk last 7d:   ${tMRC7d}`); // T922
    const tMRC30d = (t as Record<string, unknown>)['midRiskCountLast30d'] as number | undefined;
    if (tMRC30d != null) console.log(`  Mid risk last 30d:  ${tMRC30d}`); // T923
    const tMRC48 = (t as Record<string, unknown>)['midRiskCountLast48h'] as number | undefined;
    if (tMRC48 != null) console.log(`  Mid risk last 48h:  ${tMRC48}`); // T924
    const tMRC12 = (t as Record<string, unknown>)['midRiskCountLast12h'] as number | undefined;
    if (tMRC12 != null) console.log(`  Mid risk last 12h:  ${tMRC12}`); // T925
    const tOL6 = (t as Record<string, unknown>)['opsLast6h'] as number | undefined;
    if (tOL6 != null) console.log(`  Ops last 6h:        ${tOL6}`); // T926
    const tBL6 = (t as Record<string, unknown>)['blocksLast6h'] as number | undefined;
    if (tBL6 != null) console.log(`  Blocks last 6h:     ${tBL6}`); // T927
    const tAL6 = (t as Record<string, unknown>)['allowsLast6h'] as number | undefined;
    if (tAL6 != null) console.log(`  Allows last 6h:     ${tAL6}`); // T928
    const tBR6 = (t as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (tBR6 != null) console.log(`  Block rate 6h:      ${(tBR6 * 100).toFixed(1)}%`); // T929
    const tAR6 = (t as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (tAR6 != null) console.log(`  Allow rate 6h:      ${(tAR6 * 100).toFixed(1)}%`); // T930
    const tAPC6 = (t as Record<string, unknown>)['approvalCountLast6h'] as number | undefined;
    if (tAPC6 != null) console.log(`  Approvals last 6h:  ${tAPC6}`); // T931
    const tARL6_b = (t as Record<string, unknown>)['avgRiskLast6h'] as number | null | undefined;
    if (tARL6_b != null) console.log(`  Avg risk 6h:        ${tARL6_b.toFixed(3)}`); // T932
    const tHRC6 = (t as Record<string, unknown>)['highRiskCountLast6h'] as number | undefined;
    if (tHRC6 != null) console.log(`  High risk last 6h:  ${tHRC6}`); // T933
    const tLRC6 = (t as Record<string, unknown>)['lowRiskCountLast6h'] as number | undefined;
    if (tLRC6 != null) console.log(`  Low risk last 6h:   ${tLRC6}`); // T934
    const tMRC6 = (t as Record<string, unknown>)['midRiskCountLast6h'] as number | undefined;
    if (tMRC6 != null) console.log(`  Mid risk last 6h:   ${tMRC6}`); // T935
    const tRV6 = (t as Record<string, unknown>)['riskVolatilityLast6h'] as number | null | undefined;
    if (tRV6 != null) console.log(`  Risk volatility 6h: ${tRV6.toFixed(3)}`); // T936
    const tBSC_b = (t as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (tBSC_b != null && tBSC_b > 0) console.log(`  Block streak:       ${tBSC_b}`); // T937
    const tASC_b = (t as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (tASC_b != null && tASC_b > 0) console.log(`  Allow streak:       ${tASC_b}`); // T938
    const tAPSC = (t as Record<string, unknown>)['approvalStreakCurrent'] as number | undefined;
    if (tAPSC != null && tAPSC > 0) console.log(`  Approval streak:    ${tAPSC}`); // T939
    const tRV24 = (t as Record<string, unknown>)['riskVolatilityLast24h'] as number | null | undefined;
    if (tRV24 != null) console.log(`  Risk volatility 24h:${tRV24.toFixed(3)}`); // T940
    const tRV7d = (t as Record<string, unknown>)['riskVolatilityLast7d'] as number | null | undefined;
    if (tRV7d != null) console.log(`  Risk volatility 7d: ${tRV7d.toFixed(3)}`); // T941
    const tBRL6_b = (t as Record<string, unknown>)['blockRatioLast6h'] as number | null | undefined;
    if (tBRL6_b != null) console.log(`  Block ratio 6h:     ${(tBRL6_b * 100).toFixed(1)}%`); // T942
    const tBRL24_b = (t as Record<string, unknown>)['blockRatioLast24h'] as number | null | undefined;
    if (tBRL24_b != null) console.log(`  Block ratio 24h:    ${(tBRL24_b * 100).toFixed(1)}%`); // T943
    const tBRL7d = (t as Record<string, unknown>)['blockRatioLast7d'] as number | null | undefined;
    if (tBRL7d != null) console.log(`  Block ratio 7d:     ${(tBRL7d * 100).toFixed(1)}%`); // T944
    const tBRL30d = (t as Record<string, unknown>)['blockRatioLast30d'] as number | null | undefined;
    if (tBRL30d != null) console.log(`  Block ratio 30d:    ${(tBRL30d * 100).toFixed(1)}%`); // T945
    const tAIM24 = (t as Record<string, unknown>)['avgIntervalMsLast24h'] as number | null | undefined;
    if (tAIM24 != null) console.log(`  Avg interval 24h:   ${Math.round(tAIM24 / 1000)}s`); // T946
    const tAIM7d = (t as Record<string, unknown>)['avgIntervalMsLast7d'] as number | null | undefined;
    if (tAIM7d != null) console.log(`  Avg interval 7d:    ${Math.round(tAIM7d / 1000)}s`); // T947
    const tPHOD_b = (t as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (tPHOD_b != null) console.log(`  Peak hour (UTC):    ${tPHOD_b}:00`); // T948
    const days7t = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const tPDOW = (t as Record<string, unknown>)['peakDayOfWeek'] as number | null | undefined;
    if (tPDOW != null) console.log(`  Peak day:           ${days7t[tPDOW]}`); // T949
    const tLADOW = (t as Record<string, unknown>)['leastActiveDayOfWeek'] as number | null | undefined;
    if (tLADOW != null) console.log(`  Least active day:   ${days7t[tLADOW]}`); // T950
    const tLAHOD = (t as Record<string, unknown>)['leastActiveHourOfDay'] as number | null | undefined;
    if (tLAHOD != null) console.log(`  Least active hour:  ${tLAHOD}:00`); // T951
    const tOL1_b = (t as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (tOL1_b != null) console.log(`  Ops last 1h:        ${tOL1_b}`); // T952
    const tBL1_b = (t as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (tBL1_b != null) console.log(`  Blocks last 1h:     ${tBL1_b}`); // T953
    const tAL1 = (t as Record<string, unknown>)['allowsLast1h'] as number | undefined;
    if (tAL1 != null) console.log(`  Allows last 1h:     ${tAL1}`); // T954
    const tARL1 = (t as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (tARL1 != null) console.log(`  Avg risk 1h:        ${tARL1.toFixed(3)}`); // T955
    const tHRC1 = (t as Record<string, unknown>)['highRiskCountLast1h'] as number | undefined;
    if (tHRC1 != null) console.log(`  High risk last 1h:  ${tHRC1}`); // T956
    const tBR1 = (t as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (tBR1 != null) console.log(`  Block rate 1h:      ${(tBR1 * 100).toFixed(1)}%`); // T957
    const tAR1 = (t as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (tAR1 != null) console.log(`  Allow rate 1h:      ${(tAR1 * 100).toFixed(1)}%`); // T958
    const tAPR1 = (t as Record<string, unknown>)['approvalRateLast1h'] as number | null | undefined;
    if (tAPR1 != null) console.log(`  Approval rate 1h:   ${(tAPR1 * 100).toFixed(1)}%`); // T959
    const tRV1 = (t as Record<string, unknown>)['riskVolatilityLast1h'] as number | null | undefined;
    if (tRV1 != null) console.log(`  Risk volatility 1h: ${tRV1.toFixed(3)}`); // T960
    const tAPC1 = (t as Record<string, unknown>)['approvalCountLast1h'] as number | undefined;
    if (tAPC1 != null) console.log(`  Approvals last 1h:  ${tAPC1}`); // T961
    const tLRC1 = (t as Record<string, unknown>)['lowRiskCountLast1h'] as number | undefined;
    if (tLRC1 != null) console.log(`  Low risk last 1h:   ${tLRC1}`); // T962
    const tMRC1 = (t as Record<string, unknown>)['midRiskCountLast1h'] as number | undefined;
    if (tMRC1 != null) console.log(`  Mid risk last 1h:   ${tMRC1}`); // T963
    const tBRL1 = (t as Record<string, unknown>)['blockRatioLast1h'] as number | null | undefined;
    if (tBRL1 != null) console.log(`  Block ratio 1h:     ${(tBRL1 * 100).toFixed(1)}%`); // T964
    const tRWB24 = (t as Record<string, unknown>)['riskWeightedBlocksLast24h'] as number | null | undefined;
    if (tRWB24 != null) console.log(`  Risk-wtd blocks 24h:${tRWB24.toFixed(2)}`); // T965
    const tRWA24 = (t as Record<string, unknown>)['riskWeightedAllowsLast24h'] as number | null | undefined;
    if (tRWA24 != null) console.log(`  Risk-wtd allows 24h:${tRWA24.toFixed(2)}`); // T966
    const tRWB7 = (t as Record<string, unknown>)['riskWeightedBlocksLast7d'] as number | null | undefined;
    if (tRWB7 != null) console.log(`  Risk-wtd blocks 7d: ${tRWB7.toFixed(2)}`); // T967
    const tRWA7 = (t as Record<string, unknown>)['riskWeightedAllowsLast7d'] as number | null | undefined;
    if (tRWA7 != null) console.log(`  Risk-wtd allows 7d: ${tRWA7.toFixed(2)}`); // T968
    const tRWB30 = (t as Record<string, unknown>)['riskWeightedBlocksLast30d'] as number | null | undefined;
    if (tRWB30 != null) console.log(`  Risk-wtd blocks 30d:${tRWB30.toFixed(2)}`); // T969
    const tRWA30 = (t as Record<string, unknown>)['riskWeightedAllowsLast30d'] as number | null | undefined;
    if (tRWA30 != null) console.log(`  Risk-wtd allows 30d:${tRWA30.toFixed(2)}`); // T970
    const tNRW24 = (t as Record<string, unknown>)['netRiskWeightLast24h'] as number | undefined;
    if (tNRW24 != null) console.log(`  Net risk weight 24h:${tNRW24.toFixed(2)}`); // T971
    const tNRW7 = (t as Record<string, unknown>)['netRiskWeightLast7d'] as number | undefined;
    if (tNRW7 != null) console.log(`  Net risk weight 7d: ${tNRW7.toFixed(2)}`); // T972
    const tARWB24 = (t as Record<string, unknown>)['avgRiskWeightPerBlockLast24h'] as number | null | undefined;
    if (tARWB24 != null) console.log(`  Avg risk/block 24h: ${tARWB24.toFixed(3)}`); // T973
    const tARWA24 = (t as Record<string, unknown>)['avgRiskWeightPerAllowLast24h'] as number | null | undefined;
    if (tARWA24 != null) console.log(`  Avg risk/allow 24h: ${tARWA24.toFixed(3)}`); // T974
    const tARWB7 = (t as Record<string, unknown>)['avgRiskWeightPerBlockLast7d'] as number | null | undefined;
    if (tARWB7 != null) console.log(`  Avg risk/block 7d:  ${tARWB7.toFixed(3)}`); // T975
    const tARWA7 = (t as Record<string, unknown>)['avgRiskWeightPerAllowLast7d'] as number | null | undefined;
    if (tARWA7 != null) console.log(`  Avg risk/allow 7d:  ${tARWA7.toFixed(3)}`); // T976
    const tNRW30 = (t as Record<string, unknown>)['netRiskWeightLast30d'] as number | undefined;
    if (tNRW30 != null) console.log(`  Net risk weight 30d:${tNRW30.toFixed(2)}`); // T977
    const tARWB30 = (t as Record<string, unknown>)['avgRiskWeightPerBlockLast30d'] as number | null | undefined;
    if (tARWB30 != null) console.log(`  Avg risk/block 30d: ${tARWB30.toFixed(3)}`); // T978
    const tARWA30 = (t as Record<string, unknown>)['avgRiskWeightPerAllowLast30d'] as number | null | undefined;
    if (tARWA30 != null) console.log(`  Avg risk/allow 30d: ${tARWA30.toFixed(3)}`); // T979
    const tBAR24 = (t as Record<string, unknown>)['blockToAllowRatioLast24h'] as number | null | undefined;
    if (tBAR24 != null) console.log(`  Block:allow ratio 24h:${tBAR24.toFixed(2)}`); // T980
    const tBAR7 = (t as Record<string, unknown>)['blockToAllowRatioLast7d'] as number | null | undefined;
    if (tBAR7 != null) console.log(`  Block:allow ratio 7d: ${tBAR7.toFixed(2)}`); // T981
    const tBAR30 = (t as Record<string, unknown>)['blockToAllowRatioLast30d'] as number | null | undefined;
    if (tBAR30 != null) console.log(`  Block:allow ratio 30d:${tBAR30.toFixed(2)}`); // T982
    const tRSM24 = (t as Record<string, unknown>)['riskScoreMomentumLast24h'] as number | null | undefined;
    if (tRSM24 != null) console.log(`  Risk momentum 24h:  ${tRSM24 >= 0 ? '+' : ''}${tRSM24.toFixed(3)}`); // T983
    const tRSM7 = (t as Record<string, unknown>)['riskScoreMomentumLast7d'] as number | null | undefined;
    if (tRSM7 != null) console.log(`  Risk momentum 7d:   ${tRSM7 >= 0 ? '+' : ''}${tRSM7.toFixed(3)}`); // T984
    const tATBR24 = (t as Record<string, unknown>)['approvalToBlockRatioLast24h'] as number | null | undefined;
    if (tATBR24 != null) console.log(`  Approval:block 24h: ${tATBR24.toFixed(2)}`); // T985
    const tATBR7 = (t as Record<string, unknown>)['approvalToBlockRatioLast7d'] as number | null | undefined;
    if (tATBR7 != null) console.log(`  Approval:block 7d:  ${tATBR7.toFixed(2)}`); // T986
    const tOPH24 = (t as Record<string, unknown>)['opsPerHourLast24h'] as number | undefined;
    if (tOPH24 != null) console.log(`  Ops/hour last 24h:  ${tOPH24.toFixed(2)}`); // T987
    const tOPH7 = (t as Record<string, unknown>)['opsPerHourLast7d'] as number | undefined;
    if (tOPH7 != null) console.log(`  Ops/hour last 7d:   ${tOPH7.toFixed(2)}`); // T988
    const tOPH30 = (t as Record<string, unknown>)['opsPerHourLast30d'] as number | undefined;
    if (tOPH30 != null) console.log(`  Ops/hour last 30d:  ${tOPH30.toFixed(2)}`); // T989
    const tBPH24 = (t as Record<string, unknown>)['blocksPerHourLast24h'] as number | undefined;
    if (tBPH24 != null) console.log(`  Blocks/hr 24h:      ${tBPH24.toFixed(2)}`); // T990
    const tBPH7 = (t as Record<string, unknown>)['blocksPerHourLast7d'] as number | undefined;
    if (tBPH7 != null) console.log(`  Blocks/hr 7d:       ${tBPH7.toFixed(2)}`); // T991
    const tAPH24 = (t as Record<string, unknown>)['allowsPerHourLast24h'] as number | undefined;
    if (tAPH24 != null) console.log(`  Allows/hr 24h:      ${tAPH24.toFixed(2)}`); // T992
    const tAPH7 = (t as Record<string, unknown>)['allowsPerHourLast7d'] as number | undefined;
    if (tAPH7 != null) console.log(`  Allows/hr 7d:       ${tAPH7.toFixed(2)}`); // T993
    const tAPH30 = (t as Record<string, unknown>)['allowsPerHourLast30d'] as number | undefined;
    if (tAPH30 != null) console.log(`  Allows/hr 30d:      ${tAPH30.toFixed(2)}`); // T994
    const tBPH30 = (t as Record<string, unknown>)['blocksPerHourLast30d'] as number | undefined;
    if (tBPH30 != null) console.log(`  Blocks/hr 30d:      ${tBPH30.toFixed(2)}`); // T995
    const tHRPH24 = (t as Record<string, unknown>)['highRiskOpsPerHourLast24h'] as number | undefined;
    if (tHRPH24 != null) console.log(`  HiRisk ops/hr 24h:  ${tHRPH24.toFixed(2)}`); // T996
    const tHRPH7 = (t as Record<string, unknown>)['highRiskOpsPerHourLast7d'] as number | undefined;
    if (tHRPH7 != null) console.log(`  HiRisk ops/hr 7d:   ${tHRPH7.toFixed(2)}`); // T997
    const tUTC24 = (t as Record<string, unknown>)['uniqueToolsCountLast24h'] as number | undefined;
    if (tUTC24 != null) console.log(`  Unique tools 24h:   ${tUTC24}`); // T998
    const tUTC7 = (t as Record<string, unknown>)['uniqueToolsCountLast7d'] as number | undefined;
    if (tUTC7 != null) console.log(`  Unique tools 7d:    ${tUTC7}`); // T999
    const tUAC24 = (t as Record<string, unknown>)['uniqueAgentsCountLast24h'] as number | undefined;
    if (tUAC24 != null) console.log(`  Unique agents 24h:  ${tUAC24}`); // T1000
    const tUAC7 = (t as Record<string, unknown>)['uniqueAgentsCountLast7d'] as number | undefined;
    if (tUAC7 != null) console.log(`  Unique agents 7d:   ${tUAC7}`); // T1001
    const tMXR24 = (t as Record<string, unknown>)['maxRiskLast24h'] as number | null | undefined;
    if (tMXR24 != null) console.log(`  Max risk 24h:       ${tMXR24.toFixed(3)}`); // T1002
    const tMXR7 = (t as Record<string, unknown>)['maxRiskLast7d'] as number | null | undefined;
    if (tMXR7 != null) console.log(`  Max risk 7d:        ${tMXR7.toFixed(3)}`); // T1003
    const tMNR24 = (t as Record<string, unknown>)['minRiskLast24h'] as number | null | undefined;
    if (tMNR24 != null) console.log(`  Min risk 24h:       ${tMNR24.toFixed(3)}`); // T1004
    const tMNR7 = (t as Record<string, unknown>)['minRiskLast7d'] as number | null | undefined;
    if (tMNR7 != null) console.log(`  Min risk 7d:        ${tMNR7.toFixed(3)}`); // T1005
    const tMXR30 = (t as Record<string, unknown>)['maxRiskLast30d'] as number | null | undefined;
    if (tMXR30 != null) console.log(`  Max risk 30d:       ${tMXR30.toFixed(3)}`); // T1006
    const tMNR30 = (t as Record<string, unknown>)['minRiskLast30d'] as number | null | undefined;
    if (tMNR30 != null) console.log(`  Min risk 30d:       ${tMNR30.toFixed(3)}`); // T1007
    const tRRL24 = (t as Record<string, unknown>)['riskRangeLast24h'] as number | null | undefined;
    if (tRRL24 != null) console.log(`  Risk range 24h:     ${tRRL24.toFixed(3)}`); // T1008
    const tRRL7 = (t as Record<string, unknown>)['riskRangeLast7d'] as number | null | undefined;
    if (tRRL7 != null) console.log(`  Risk range 7d:      ${tRRL7.toFixed(3)}`); // T1009
    const tRRL30 = (t as Record<string, unknown>)['riskRangeLast30d'] as number | null | undefined;
    if (tRRL30 != null) console.log(`  Risk range 30d:     ${tRRL30.toFixed(3)}`); // T1010
    const tP25_b = (t as Record<string, unknown>)['p25Risk'] as number | null | undefined;
    if (tP25_b != null) console.log(`  P25 risk:           ${tP25_b.toFixed(3)}`); // T1011
    const tP75 = (t as Record<string, unknown>)['p75Risk'] as number | null | undefined;
    if (tP75 != null) console.log(`  P75 risk:           ${tP75.toFixed(3)}`); // T1012
    const tIQR_b = (t as Record<string, unknown>)['iqrRisk'] as number | null | undefined;
    if (tIQR_b != null) console.log(`  IQR risk:           ${tIQR_b.toFixed(3)}`); // T1013
    const tP95_b = (t as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (tP95_b != null) console.log(`  P95 risk:           ${tP95_b.toFixed(3)}`); // T1014
    const tP5 = (t as Record<string, unknown>)['p5Risk'] as number | null | undefined;
    if (tP5 != null) console.log(`  P5 risk:            ${tP5.toFixed(3)}`); // T1015
    const tRSS = (t as Record<string, unknown>)['riskSkewnessSign'] as number | null | undefined;
    if (tRSS != null) console.log(`  Risk skewness sign: ${tRSS}`); // T1016
    const tAPR30 = (t as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (tAPR30 != null) console.log(`  Approval rate 30d:  ${(tAPR30 * 100).toFixed(1)}%`); // T1017
    const tAPC30 = (t as Record<string, unknown>)['approvalCountLast30d'] as number | undefined;
    if (tAPC30 != null && tAPC30 > 0) console.log(`  Approvals 30d:      ${tAPC30}`); // T1018
    const tBC1h = (t as Record<string, unknown>)['blockCountLast1h'] as number | undefined;
    if (tBC1h != null && tBC1h > 0) console.log(`  Blocks last 1h:     ${tBC1h}`); // T1019
    const tAC1h = (t as Record<string, unknown>)['allowCountLast1h'] as number | undefined;
    if (tAC1h != null && tAC1h > 0) console.log(`  Allows last 1h:     ${tAC1h}`); // T1020
    const tAPC24_b = (t as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (tAPC24_b != null && tAPC24_b > 0) console.log(`  Approvals 24h:      ${tAPC24_b}`); // T1021
    const tAPC7 = (t as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (tAPC7 != null && tAPC7 > 0) console.log(`  Approvals 7d:       ${tAPC7}`); // T1022
    const tAPR24_b = (t as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (tAPR24_b != null) console.log(`  Approval rate 24h:  ${(tAPR24_b * 100).toFixed(1)}%`); // T1023
    const tAPR7 = (t as Record<string, unknown>)['approvalRateLast7d'] as number | null | undefined;
    if (tAPR7 != null) console.log(`  Approval rate 7d:   ${(tAPR7 * 100).toFixed(1)}%`); // T1024
    const tBR1h = (t as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (tBR1h != null) console.log(`  Block rate 1h:      ${(tBR1h * 100).toFixed(1)}%`); // T1025
    const tAR1h = (t as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (tAR1h != null) console.log(`  Allow rate 1h:      ${(tAR1h * 100).toFixed(1)}%`); // T1026
    const tBR7 = (t as Record<string, unknown>)['blockRateLast7d'] as number | null | undefined;
    if (tBR7 != null) console.log(`  Block rate 7d:      ${(tBR7 * 100).toFixed(1)}%`); // T1027
    const tAR7 = (t as Record<string, unknown>)['allowRateLast7d'] as number | null | undefined;
    if (tAR7 != null) console.log(`  Allow rate 7d:      ${(tAR7 * 100).toFixed(1)}%`); // T1028
    const tBR30 = (t as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (tBR30 != null) console.log(`  Block rate 30d:     ${(tBR30 * 100).toFixed(1)}%`); // T1029
    const tAR30 = (t as Record<string, unknown>)['allowRateLast30d'] as number | null | undefined;
    if (tAR30 != null) console.log(`  Allow rate 30d:     ${(tAR30 * 100).toFixed(1)}%`); // T1030
    const tOC1h = (t as Record<string, unknown>)['opCountLast1h'] as number | undefined;
    if (tOC1h != null && tOC1h > 0) console.log(`  Ops last 1h:        ${tOC1h}`); // T1031
    const tOC24 = (t as Record<string, unknown>)['opCountLast24h'] as number | undefined;
    if (tOC24 != null && tOC24 > 0) console.log(`  Ops last 24h:       ${tOC24}`); // T1032
    const tOC7 = (t as Record<string, unknown>)['opCountLast7d'] as number | undefined;
    if (tOC7 != null && tOC7 > 0) console.log(`  Ops last 7d:        ${tOC7}`); // T1033
    const tOC30 = (t as Record<string, unknown>)['opCountLast30d'] as number | undefined;
    if (tOC30 != null && tOC30 > 0) console.log(`  Ops last 30d:       ${tOC30}`); // T1034
    const tBC24 = (t as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (tBC24 != null && tBC24 > 0) console.log(`  Blocks 24h:         ${tBC24}`); // T1035
    const tBC7 = (t as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (tBC7 != null && tBC7 > 0) console.log(`  Blocks 7d:          ${tBC7}`); // T1036
    const tBC30 = (t as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (tBC30 != null && tBC30 > 0) console.log(`  Blocks 30d:         ${tBC30}`); // T1037
    const tAC24 = (t as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (tAC24 != null && tAC24 > 0) console.log(`  Allows 24h:         ${tAC24}`); // T1038
    const tAC7 = (t as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (tAC7 != null && tAC7 > 0) console.log(`  Allows 7d:          ${tAC7}`); // T1039
    const tAC30 = (t as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (tAC30 != null && tAC30 > 0) console.log(`  Allows 30d:         ${tAC30}`); // T1040
    const tHRC24_b = (t as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (tHRC24_b != null && tHRC24_b > 0) console.log(`  High-risk 24h:      ${tHRC24_b}`); // T1041
    const tHRC7 = (t as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (tHRC7 != null && tHRC7 > 0) console.log(`  High-risk 7d:       ${tHRC7}`); // T1042
    const tHRC30 = (t as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (tHRC30 != null && tHRC30 > 0) console.log(`  High-risk 30d:      ${tHRC30}`); // T1043
    const tHRR24 = (t as Record<string, unknown>)['highRiskRateLast24h'] as number | null | undefined;
    if (tHRR24 != null) console.log(`  High-risk rate 24h: ${(tHRR24 * 100).toFixed(1)}%`); // T1044
    const tHRR7 = (t as Record<string, unknown>)['highRiskRateLast7d'] as number | null | undefined;
    if (tHRR7 != null) console.log(`  High-risk rate 7d:  ${(tHRR7 * 100).toFixed(1)}%`); // T1045
    const tHRR30 = (t as Record<string, unknown>)['highRiskRateLast30d'] as number | null | undefined;
    if (tHRR30 != null) console.log(`  High-risk rate 30d: ${(tHRR30 * 100).toFixed(1)}%`); // T1046
    const tLRC24_b = (t as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (tLRC24_b != null && tLRC24_b > 0) console.log(`  Low-risk 24h:       ${tLRC24_b}`); // T1047
    const tLRC7 = (t as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (tLRC7 != null && tLRC7 > 0) console.log(`  Low-risk 7d:        ${tLRC7}`); // T1048
    const tLRC30 = (t as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (tLRC30 != null && tLRC30 > 0) console.log(`  Low-risk 30d:       ${tLRC30}`); // T1049
    const tLRR24 = (t as Record<string, unknown>)['lowRiskRateLast24h'] as number | null | undefined;
    if (tLRR24 != null) console.log(`  Low-risk rate 24h:  ${(tLRR24 * 100).toFixed(1)}%`); // T1050
    const tLRR7 = (t as Record<string, unknown>)['lowRiskRateLast7d'] as number | null | undefined;
    if (tLRR7 != null) console.log(`  Low-risk rate 7d:   ${(tLRR7 * 100).toFixed(1)}%`); // T1051
    const tLRR30 = (t as Record<string, unknown>)['lowRiskRateLast30d'] as number | null | undefined;
    if (tLRR30 != null) console.log(`  Low-risk rate 30d:  ${(tLRR30 * 100).toFixed(1)}%`); // T1052
    const tMRC24_b = (t as Record<string, unknown>)['medRiskCountLast24h'] as number | undefined;
    if (tMRC24_b != null && tMRC24_b > 0) console.log(`  Med-risk 24h:       ${tMRC24_b}`); // T1053
    const tMRC7 = (t as Record<string, unknown>)['medRiskCountLast7d'] as number | undefined;
    if (tMRC7 != null && tMRC7 > 0) console.log(`  Med-risk 7d:        ${tMRC7}`); // T1054
    const tMRC30 = (t as Record<string, unknown>)['medRiskCountLast30d'] as number | undefined;
    if (tMRC30 != null && tMRC30 > 0) console.log(`  Med-risk 30d:       ${tMRC30}`); // T1055
    const tMRR24 = (t as Record<string, unknown>)['medRiskRateLast24h'] as number | null | undefined;
    if (tMRR24 != null) console.log(`  Med-risk rate 24h:  ${(tMRR24 * 100).toFixed(1)}%`); // T1056
    const tMRR7 = (t as Record<string, unknown>)['medRiskRateLast7d'] as number | null | undefined;
    if (tMRR7 != null) console.log(`  Med-risk rate 7d:   ${(tMRR7 * 100).toFixed(1)}%`); // T1057
    const tMRR30 = (t as Record<string, unknown>)['medRiskRateLast30d'] as number | null | undefined;
    if (tMRR30 != null) console.log(`  Med-risk rate 30d:  ${(tMRR30 * 100).toFixed(1)}%`); // T1058
    const tRV24_b = (t as Record<string, unknown>)['riskVarianceLast24h'] as number | null | undefined;
    if (tRV24_b != null) console.log(`  Risk variance 24h:  ${tRV24_b.toFixed(4)}`); // T1059
    const tRV7 = (t as Record<string, unknown>)['riskVarianceLast7d'] as number | null | undefined;
    if (tRV7 != null) console.log(`  Risk variance 7d:   ${tRV7.toFixed(4)}`); // T1060
    const tRSD24 = (t as Record<string, unknown>)['riskStdDevLast24h'] as number | null | undefined;
    if (tRSD24 != null) console.log(`  Risk std dev 24h:   ${tRSD24.toFixed(3)}`); // T1061
    const tRSD7 = (t as Record<string, unknown>)['riskStdDevLast7d'] as number | null | undefined;
    if (tRSD7 != null) console.log(`  Risk std dev 7d:    ${tRSD7.toFixed(3)}`); // T1062
    const tRSD30 = (t as Record<string, unknown>)['riskStdDevLast30d'] as number | null | undefined;
    if (tRSD30 != null) console.log(`  Risk std dev 30d:   ${tRSD30.toFixed(3)}`); // T1063
    const tRVA30 = (t as Record<string, unknown>)['riskVarianceLast30d'] as number | null | undefined;
    if (tRVA30 != null) console.log(`  Risk variance 30d:  ${tRVA30.toFixed(4)}`); // T1064
    const tAR1h_b = (t as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (tAR1h_b != null) console.log(`  Avg risk 1h:        ${tAR1h_b.toFixed(3)}`); // T1065
    const tAR24 = (t as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (tAR24 != null) console.log(`  Avg risk 24h:       ${tAR24.toFixed(3)}`); // T1066
    const tAR7_b = (t as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (tAR7_b != null) console.log(`  Avg risk 7d:        ${tAR7_b.toFixed(3)}`); // T1067
    const tAR30_b = (t as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (tAR30_b != null) console.log(`  Avg risk 30d:       ${tAR30_b.toFixed(3)}`); // T1068
    const tART1h = (t as Record<string, unknown>)['avgRiskTrend1hVs24h'] as number | null | undefined;
    if (tART1h != null) console.log(`  Avg risk trend 1h>24h: ${tART1h.toFixed(3)}`); // T1069
    const tART24 = (t as Record<string, unknown>)['avgRiskTrend24hVs7d'] as number | null | undefined;
    if (tART24 != null) console.log(`  Avg risk trend 24h>7d: ${tART24.toFixed(3)}`); // T1070
    const tART7 = (t as Record<string, unknown>)['avgRiskTrend7dVs30d'] as number | null | undefined;
    if (tART7 != null) console.log(`  Avg risk trend 7d>30d: ${tART7.toFixed(3)}`); // T1071
    const tMXR_b = (t as Record<string, unknown>)['maxRiskAllTime'] as number | null | undefined;
    if (tMXR_b != null) console.log(`  Max risk all-time:     ${tMXR_b.toFixed(3)}`); // T1072
    const tMNR_b = (t as Record<string, unknown>)['minRiskAllTime'] as number | null | undefined;
    if (tMNR_b != null) console.log(`  Min risk all-time:     ${tMNR_b.toFixed(3)}`); // T1073
    const tOCT1 = (t as Record<string, unknown>)['opCountTrend1hVs24h'] as number | null | undefined;
    if (tOCT1 != null) console.log(`  Op count trend 1h>24h: ${tOCT1.toFixed(2)}`); // T1074
    const tOCT24 = (t as Record<string, unknown>)['opCountTrend24hVs7d'] as number | null | undefined;
    if (tOCT24 != null) console.log(`  Op count trend 24h>7d: ${tOCT24.toFixed(2)}`); // T1075
    const tBCT = (t as Record<string, unknown>)['blockCountTrend1hVs24h'] as number | null | undefined;
    if (tBCT != null) console.log(`  Block count trend 1h>24h: ${tBCT.toFixed(2)}`); // T1076
    const tACT = (t as Record<string, unknown>)['allowCountTrend1hVs24h'] as number | null | undefined;
    if (tACT != null) console.log(`  Allow count trend 1h>24h: ${tACT.toFixed(2)}`); // T1077
    const tAPCT = (t as Record<string, unknown>)['approvalCountTrend1hVs24h'] as number | null | undefined;
    if (tAPCT != null) console.log(`  Approval count trend 1h>24h: ${tAPCT.toFixed(2)}`); // T1078
    const tBCT24 = (t as Record<string, unknown>)['blockCountTrend24hVs7d'] as number | null | undefined;
    if (tBCT24 != null) console.log(`  Block count trend 24h>7d:  ${tBCT24.toFixed(2)}`); // T1079
    const tACT24 = (t as Record<string, unknown>)['allowCountTrend24hVs7d'] as number | null | undefined;
    if (tACT24 != null) console.log(`  Allow count trend 24h>7d:  ${tACT24.toFixed(2)}`); // T1080
    const tAPCT24 = (t as Record<string, unknown>)['approvalCountTrend24hVs7d'] as number | null | undefined;
    if (tAPCT24 != null) console.log(`  Approval count trend 24h>7d: ${tAPCT24.toFixed(2)}`); // T1081
    const tBCT7 = (t as Record<string, unknown>)['blockCountTrend7dVs30d'] as number | null | undefined;
    if (tBCT7 != null) console.log(`  Block count trend 7d>30d:  ${tBCT7.toFixed(2)}`); // T1082
    const tACT7 = (t as Record<string, unknown>)['allowCountTrend7dVs30d'] as number | null | undefined;
    if (tACT7 != null) console.log(`  Allow count trend 7d>30d:  ${tACT7.toFixed(2)}`); // T1083
    const tAPCT7 = (t as Record<string, unknown>)['approvalCountTrend7dVs30d'] as number | null | undefined;
    if (tAPCT7 != null) console.log(`  Approval count trend 7d>30d: ${tAPCT7.toFixed(2)}`); // T1084
    const tRRA = (t as Record<string, unknown>)['riskRangeAllTime'] as number | null | undefined;
    if (tRRA != null) console.log(`  Risk range all-time:   ${tRRA.toFixed(3)}`); // T1085
    const tRP25 = (t as Record<string, unknown>)['riskP25'] as number | null | undefined;
    if (tRP25 != null) console.log(`  Risk P25:              ${tRP25.toFixed(3)}`); // T1086
    const tRP75 = (t as Record<string, unknown>)['riskP75'] as number | null | undefined;
    if (tRP75 != null) console.log(`  Risk P75:              ${tRP75.toFixed(3)}`); // T1087
    const tRIQR_c = (t as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (tRIQR_c != null) console.log(`  Risk IQR:              ${tRIQR_c.toFixed(3)}`); // T1088
    const tRP25h24 = (t as Record<string, unknown>)['riskP25Last24h'] as number | null | undefined;
    if (tRP25h24 != null) console.log(`  Risk P25 24h:          ${tRP25h24.toFixed(3)}`); // T1089
    const tRP75h24 = (t as Record<string, unknown>)['riskP75Last24h'] as number | null | undefined;
    if (tRP75h24 != null) console.log(`  Risk P75 24h:          ${tRP75h24.toFixed(3)}`); // T1090
    const tRIQRh24 = (t as Record<string, unknown>)['riskIQRLast24h'] as number | null | undefined;
    if (tRIQRh24 != null) console.log(`  Risk IQR 24h:          ${tRIQRh24.toFixed(3)}`); // T1091
    const tRP25d7 = (t as Record<string, unknown>)['riskP25Last7d'] as number | null | undefined;
    if (tRP25d7 != null) console.log(`  Risk P25 7d:           ${tRP25d7.toFixed(3)}`); // T1092
    const tRP75d7 = (t as Record<string, unknown>)['riskP75Last7d'] as number | null | undefined;
    if (tRP75d7 != null) console.log(`  Risk P75 7d:           ${tRP75d7.toFixed(3)}`); // T1093
    const tRIQRd7 = (t as Record<string, unknown>)['riskIQRLast7d'] as number | null | undefined;
    if (tRIQRd7 != null) console.log(`  Risk IQR 7d:           ${tRIQRd7.toFixed(3)}`); // T1094
    const tRP25d30 = (t as Record<string, unknown>)['riskP25Last30d'] as number | null | undefined;
    if (tRP25d30 != null) console.log(`  Risk P25 30d:          ${tRP25d30.toFixed(3)}`); // T1095
    const tRP75d30 = (t as Record<string, unknown>)['riskP75Last30d'] as number | null | undefined;
    if (tRP75d30 != null) console.log(`  Risk P75 30d:          ${tRP75d30.toFixed(3)}`); // T1096
    const tRIQRd30 = (t as Record<string, unknown>)['riskIQRLast30d'] as number | null | undefined;
    if (tRIQRd30 != null) console.log(`  Risk IQR 30d:          ${tRIQRd30.toFixed(3)}`); // T1097
    const tRP10 = (t as Record<string, unknown>)['riskP10'] as number | null | undefined;
    if (tRP10 != null) console.log(`  Risk P10:              ${tRP10.toFixed(3)}`); // T1098
    const tDOW = (t as Record<string, unknown>)['avgRiskByDayOfWeek'] as Array<number | null> | undefined;
    if (tDOW && tDOW.some(v => v !== null)) { // T649
      const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      const dowStr = tDOW.map((v, i) => `${days[i]}:${v !== null ? (v*100).toFixed(0)+'%' : '--'}`).join(' ');
      console.log(`  Risk by day:  ${dowStr}`);
    }
    const tCBD = (t as Record<string, unknown>)['operationsCountByDay'] as number[] | undefined;
    if (tCBD && tCBD.some(v => v > 0)) { // T651
      const max = Math.max(...tCBD, 1);
      const spark = tCBD.map(v => v === 0 ? '·' : v / max >= 0.7 ? '█' : v / max >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Ops/day sparkline: ${spark} (today←6d ago)`);
    }
    return;
  }

  // T304: --limit/--offset pagination; T318: --q search flag; T332: --sort/--order; T387: --max-ops/--min-avg-risk/--max-avg-risk; T408: --method
  const toolListLimit      = parseFlag(args, 'limit');
  const toolListOffset     = parseFlag(args, 'offset');
  const toolListQ          = parseFlag(args, 'q');
  const toolListSort       = parseFlag(args, 'sort');
  const toolListOrder      = parseFlag(args, 'order');
  const toolListMaxOps     = parseFlag(args, 'max-ops');
  const toolListMinAvgRisk = parseFlag(args, 'min-avg-risk');
  const toolListMaxAvgRisk = parseFlag(args, 'max-avg-risk');
  const toolListMethod     = parseFlag(args, 'method');        // T408
  const toolListParams = new URLSearchParams();
  if (toolListLimit)      toolListParams.set('limit', toolListLimit);
  if (toolListOffset)     toolListParams.set('offset', toolListOffset);
  if (toolListQ)          toolListParams.set('q', toolListQ);
  if (toolListSort)       toolListParams.set('sort', toolListSort);
  if (toolListOrder)      toolListParams.set('order', toolListOrder);
  if (toolListMaxOps)     toolListParams.set('maxOps', toolListMaxOps);
  if (toolListMinAvgRisk) toolListParams.set('minAvgRiskScore', toolListMinAvgRisk);
  if (toolListMaxAvgRisk) toolListParams.set('maxAvgRiskScore', toolListMaxAvgRisk);
  if (toolListMethod)     toolListParams.set('method', toolListMethod);
  const toolListUrl = `/tools${toolListParams.toString() ? `?${toolListParams}` : ''}`;
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', toolListUrl);
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  const b = body as { tools: Array<{ tool: string; totalOps: number; avgRiskScore: number; blockRate?: number }>; count: number };
  if (b.count === 0) { console.log('No tools tracked yet.'); return; }
  console.log(`Tools (${b.count}):\n`);
  console.log('TOOL'.padEnd(28) + 'OPS'.padEnd(8) + 'AVG RISK'.padEnd(11) + 'BLK RATE'); // T505
  console.log('─'.repeat(60));
  for (const t of b.tools) {
    const blkRate = t.blockRate !== undefined ? `  ${(t.blockRate * 100).toFixed(1)}%` : ''; // T505
    console.log(`${t.tool.slice(0,26).padEnd(28)}${String(t.totalOps).padEnd(8)}${(t.avgRiskScore * 100).toFixed(1).padEnd(11)}${blkRate}`);
  }
}
