import { parseFlag, readState, dashFetch } from './shared.js';

export async function cmdSessionsOps(args: string[]): Promise<void> {
  // Uses /sessions (operation-based) rather than /telemetry/sessions
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }
  const sessionId = args.find(a => !a.startsWith('--'));
  if (sessionId) {
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/sessions/${encodeURIComponent(sessionId)}`);
    if (status === 404) { console.error(`Session ${sessionId} not found.`); process.exit(1); }
    const s = body as { sessionId: string; agentId: string; totalOps: number; allowed: number; blocked: number; pending: number; avgRisk: number; maxRisk?: number; minRisk?: number; highRiskCount?: number; mediumRiskCount?: number; lowRiskCount?: number; medianRiskScore?: number; p50RiskScore?: number; p95RiskScore?: number; blockRate?: number; blockStreak?: number; allowStreak?: number; sessionDuration?: number; firstSeen?: string; lastSeen?: string; recentBlockedOps?: Array<Record<string, unknown>>; recentOps: Array<Record<string, unknown>> };
    console.log(`Session: ${s.sessionId}`);
    console.log(`  Agent:     ${s.agentId}`);
    console.log(`  Ops:       ${s.totalOps} (allowed=${s.allowed} blocked=${s.blocked} pending=${s.pending})`);
    console.log(`  Avg Risk:  ${(s.avgRisk * 100).toFixed(1)}%`);
    if (s.maxRisk !== undefined)   console.log(`  Max Risk:  ${(s.maxRisk * 100).toFixed(1)}%`);   // T392
    if (s.minRisk !== undefined)   console.log(`  Min Risk:  ${(s.minRisk * 100).toFixed(1)}%`);   // T446
    if (s.highRiskCount !== undefined) console.log(`  High risk (≥70%):  ${s.highRiskCount}`); // T476
    if (s.mediumRiskCount !== undefined) console.log(`  Med risk (30-70%): ${s.mediumRiskCount}`); // T476
    if (s.lowRiskCount !== undefined) console.log(`  Low risk (<30%):   ${s.lowRiskCount}`); // T476
    if (s.medianRiskScore !== undefined) console.log(`  Median risk: ${(s.medianRiskScore * 100).toFixed(1)}%`); // T491
    if (s.p50RiskScore !== undefined) console.log(`  p50 risk:    ${(s.p50RiskScore * 100).toFixed(1)}%`); // T491
    if (s.p95RiskScore !== undefined) console.log(`  p95 risk:    ${(s.p95RiskScore * 100).toFixed(1)}%`); // T491
    if (s.blockRate !== undefined) console.log(`  Block Rate: ${(s.blockRate * 100).toFixed(1)}%`); // T392
    if (s.blockStreak !== undefined && s.blockStreak > 0) console.log(`  Block streak: ${s.blockStreak} consecutive`); // T490
    if (s.allowStreak !== undefined && s.allowStreak > 0) console.log(`  Allow streak: ${s.allowStreak} consecutive`); // T490
    if (s.firstSeen)               console.log(`  First seen: ${s.firstSeen}`);                    // T446
    if (s.lastSeen)                console.log(`  Last seen:  ${s.lastSeen}`);                     // T446
    if (s.sessionDuration !== undefined) console.log(`  Duration:  ${(s.sessionDuration / 1000).toFixed(1)}s`); // T446
    const sR1h = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (sR1h !== undefined && sR1h !== null) console.log(`  Avg risk (1h):  ${(sR1h * 100).toFixed(1)}%`); // T561
    const sR24h = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (sR24h !== undefined && sR24h !== null) console.log(`  Avg risk (24h): ${(sR24h * 100).toFixed(1)}%`); // T561
    const sBk24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    const sBk1  = (s as Record<string, unknown>)['blockCountLast1h']  as number | undefined;
    if (sBk24 !== undefined) console.log(`  Blocks (24h):   ${sBk24}  (1h: ${sBk1 ?? 0})`); // T570
    const sAR = (s as Record<string, unknown>)['avgAllowRisk'] as number | null | undefined;
    const sBR = (s as Record<string, unknown>)['avgBlockRisk'] as number | null | undefined;
    if (sAR !== undefined && sAR !== null) console.log(`  Avg risk allow: ${(sAR * 100).toFixed(1)}%  block: ${sBR !== undefined && sBR !== null ? (sBR * 100).toFixed(1) + '%' : '—'}`); // T580
    const sPR = (s as Record<string, unknown>)['avgPendingRisk'] as number | null | undefined;
    if (sPR !== undefined && sPR !== null) console.log(`  Avg risk pending: ${(sPR * 100).toFixed(1)}%`); // T591
    const sSD = (s as Record<string, unknown>)['riskScoreStdDev'] as number | undefined;
    if (sSD !== undefined && sSD > 0) console.log(`  Risk std dev:    ${(sSD * 100).toFixed(1)}%`); // T592
    const sOR = (s as Record<string, unknown>)['operationRate'] as number | undefined;
    if (sOR !== undefined) console.log(`  Op rate (24h):   ${sOR.toFixed(3)} ops/min`); // T597
    const sP25 = (s as Record<string, unknown>)['p25RiskScore'] as number | undefined;
    const sIQR = (s as Record<string, unknown>)['interquartileRange'] as number | undefined;
    if (sP25 !== undefined) console.log(`  p25 risk:        ${(sP25 * 100).toFixed(1)}%${sIQR !== undefined ? `  IQR: ${(sIQR * 100).toFixed(1)}%` : ''}`); // T606
    const sSkew = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (sSkew !== undefined && sSkew !== null) console.log(`  Risk skewness:   ${sSkew.toFixed(3)}`); // T612
    const sConc = (s as Record<string, unknown>)['riskConcentration'] as number | null | undefined;
    if (sConc !== undefined && sConc !== null) console.log(`  Risk concentration: ${(sConc * 100).toFixed(1)}% (top 20% ops)`); // T617
    const sHRR = (s as Record<string, unknown>)['highRiskRate'] as number | undefined;
    const sMRR = (s as Record<string, unknown>)['mediumRiskRate'] as number | undefined;
    const sLRR = (s as Record<string, unknown>)['lowRiskRate'] as number | undefined;
    if (sHRR !== undefined) console.log(`  Risk tiers:      H:${(sHRR*100).toFixed(1)}%${sMRR!==undefined?` M:${(sMRR*100).toFixed(1)}%`:''}${sLRR!==undefined?` L:${(sLRR*100).toFixed(1)}%`:''}`); // T636-T639
    const sRV = (s as Record<string, unknown>)['riskVelocity'] as number | null | undefined;
    if (sRV !== undefined && sRV !== null) console.log(`  Risk velocity:   ${sRV >= 0 ? '+' : ''}${(sRV * 100).toFixed(2)}% (1h delta)`); // T618
    const sBV = (s as Record<string, unknown>)['blockVelocity'] as number | null | undefined;
    if (sBV !== undefined && sBV !== null) console.log(`  Block velocity:  ${sBV >= 0 ? '+' : ''}${sBV} (1h delta)`); // T619
    const sSRP = (s as Record<string, unknown>)['sessionRiskProfile'] as { peakRisk: number; peakRiskAt: string; avgRiskFirstHalf: number | null; avgRiskSecondHalf: number | null } | null | undefined;
    if (sSRP) { // T625
      console.log(`  Session peak risk: ${(sSRP.peakRisk * 100).toFixed(0)}% at ${new Date(sSRP.peakRiskAt).toLocaleTimeString()}`);
      if (sSRP.avgRiskFirstHalf !== null && sSRP.avgRiskSecondHalf !== null) {
        const trend = sSRP.avgRiskSecondHalf > sSRP.avgRiskFirstHalf + 0.05 ? '↑' : sSRP.avgRiskSecondHalf < sSRP.avgRiskFirstHalf - 0.05 ? '↓' : '→';
        console.log(`  Session risk trend: ${trend} (1st half: ${(sSRP.avgRiskFirstHalf*100).toFixed(0)}% → 2nd: ${(sSRP.avgRiskSecondHalf*100).toFixed(0)}%)`);
      }
    }
    const sHourly = (s as Record<string, unknown>)['avgRiskByHour'] as Array<number | null> | undefined;
    if (sHourly && sHourly.some(v => v !== null)) { // T629
      const spark = sHourly.slice(0, 12).map(v => v === null ? '·' : v >= 0.7 ? '█' : v >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Risk/hr sparkline: ${spark} (last 12h, newest left)`);
    }
    const sCBRS = (s as Record<string, unknown>)['consecutiveBlockRatio'] as number | undefined;
    if (sCBRS !== undefined && sCBRS > 0) console.log(`  Consec block ratio: ${(sCBRS * 100).toFixed(1)}%`); // T659
    const sRAcc = (s as Record<string, unknown>)['riskAcceleration'] as number | null | undefined;
    if (sRAcc !== null && sRAcc !== undefined) console.log(`  Risk acceleration:  ${sRAcc >= 0 ? '+' : ''}${(sRAcc * 100).toFixed(1)}%`); // T660
    const sTSRS = (s as Record<string, unknown>)['toolSwitchRate'] as number | null | undefined;
    if (sTSRS !== null && sTSRS !== undefined) console.log(`  Tool switch rate:   ${(sTSRS * 100).toFixed(1)}%`); // T661
    const sMSRS = (s as Record<string, unknown>)['methodSwitchRate'] as number | null | undefined;
    if (sMSRS !== null && sMSRS !== undefined) console.log(`  Method switch rate: ${(sMSRS * 100).toFixed(1)}%`); // T663
    const sPOPM = (s as Record<string, unknown>)['peakOpsPerMinute'] as number | undefined;
    if (sPOPM !== undefined && sPOPM > 0) console.log(`  Peak ops/min:       ${sPOPM.toFixed(2)}`); // T662
    const sRASc = (s as Record<string, unknown>)['riskAnomalyScore'] as number | null | undefined;
    if (sRASc !== null && sRASc !== undefined) console.log(`  Risk anomaly (z):   ${sRASc >= 0 ? '+' : ''}${sRASc.toFixed(2)}`); // T664
    const sBRL = (s as Record<string, unknown>)['blockRunLengths'] as Record<string, number> | undefined;
    if (sBRL && Object.values(sBRL).some(v => v > 0)) { const parts = Object.entries(sBRL).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Block run lengths:  ${parts}`); } // T665
    const sATBO = (s as Record<string, unknown>)['avgTimeBetweenOps'] as number | null | undefined;
    if (sATBO !== null && sATBO !== undefined) console.log(`  Avg time bet. ops:  ${(sATBO / 1000).toFixed(1)}s`); // T666
    const sIR = (s as Record<string, unknown>)['idleRatio'] as number | undefined;
    if (sIR !== undefined) console.log(`  Idle ratio (24h):   ${(sIR * 100).toFixed(0)}%`); // T668
    const sRP = (s as Record<string, unknown>)['riskProfile'] as string | undefined;
    if (sRP) console.log(`  Risk profile:       ${sRP.toUpperCase()}`); // T669
    const sBBS = (s as Record<string, unknown>)['blockBurstScore'] as number | undefined;
    if (sBBS !== undefined && sBBS > 0) console.log(`  Block burst score:  ${(sBBS * 100).toFixed(1)}%`); // T670
    const sPSS = (s as Record<string, unknown>)['pendingStreak'] as number | undefined;
    if (sPSS !== undefined && sPSS > 0) console.log(`  Pending streak:     ${sPSS}`); // T671
    const sRSC = (s as Record<string, unknown>)['riskSkewnessCategory'] as string | null | undefined;
    if (sRSC) console.log(`  Risk skew:          ${sRSC}`); // T673
    const sHRMC = (s as Record<string, unknown>)['highRiskMethodCount'] as number | undefined;
    if (sHRMC !== undefined && sHRMC > 0) console.log(`  High-risk methods:  ${sHRMC}`); // T678
    const sOBS = (s as Record<string, unknown>)['opsBySeverity'] as {critical: number; high: number; medium: number; low: number} | undefined;
    if (sOBS) console.log(`  Ops by severity:    crit=${sOBS.critical} high=${sOBS.high} med=${sOBS.medium} low=${sOBS.low}`); // T676
    const sRTS = (s as Record<string, unknown>)['riskTrendSlope'] as number | null | undefined;
    if (sRTS !== null && sRTS !== undefined) console.log(`  Risk trend slope:   ${sRTS >= 0 ? '+' : ''}${sRTS.toFixed(4)}`); // T679
    const sARL30 = (s as Record<string, unknown>)['avgRiskLast30m'] as number | null | undefined;
    if (sARL30 !== null && sARL30 !== undefined) console.log(`  Avg risk (30m):     ${(sARL30 * 100).toFixed(1)}%`); // T680
    const sRBM = (s as Record<string, unknown>)['recentBlockedMethods'] as Array<{method: string; blocked: number}> | undefined;
    if (sRBM && sRBM.length > 0) console.log(`  Recent blk methods: ${sRBM.map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T681
    const sUMC = (s as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (sUMC !== undefined) console.log(`  Unique methods:     ${sUMC}`); // T686
    const sAHC = (s as Record<string, unknown>)['agentHandoffCount'] as number | undefined;
    if (sAHC !== undefined && sAHC > 0) console.log(`  Agent handoffs:     ${sAHC}`); // T689
    const sMRSS = (s as Record<string, unknown>)['maxRiskStreak'] as number | undefined;
    if (sMRSS !== undefined && sMRSS > 0) console.log(`  Max risk streak:    ${sMRSS}`); // T690
    const sP99 = (s as Record<string, unknown>)['p99RiskScore'] as number | undefined;
    if (sP99 !== undefined) console.log(`  p99 risk:           ${(sP99 * 100).toFixed(1)}%`); // T691
    const sROL5 = (s as Record<string, unknown>)['recentOpsLast5m'] as number | undefined;
    if (sROL5 !== undefined) console.log(`  Ops last 5m:        ${sROL5}`); // T692
    const sAL = (s as Record<string, unknown>)['alertLevel'] as string | undefined;
    if (sAL) console.log(`  Alert level:        ${sAL.toUpperCase()}`); // T694
    const sBRC = (s as Record<string, unknown>)['blockRateChange'] as number | null | undefined;
    if (sBRC != null) console.log(`  Block rate change:  ${sBRC >= 0 ? '+' : ''}${(sBRC * 100).toFixed(1)}%`); // T695
    const sARC = (s as Record<string, unknown>)['avgRiskChange'] as number | null | undefined;
    if (sARC != null) console.log(`  Avg risk change:    ${sARC >= 0 ? '+' : ''}${(sARC * 100).toFixed(1)}%`); // T696
    const sFHBR = (s as Record<string, unknown>)['firstHalfBlockRate'] as number | null | undefined;
    const sSHBR = (s as Record<string, unknown>)['secondHalfBlockRate'] as number | null | undefined;
    if (sFHBR != null && sSHBR != null) console.log(`  Block rate halves:  ${(sFHBR*100).toFixed(1)}% → ${(sSHBR*100).toFixed(1)}%`); // T697
    const sTRWS = (s as Record<string, unknown>)['topRiskWindowStart'] as string | null | undefined;
    if (sTRWS) console.log(`  Peak risk window:   ${new Date(sTRWS).toLocaleTimeString()}`); // T698
    const sOT24 = (s as Record<string, unknown>)['opsTrend24h'] as number[] | undefined;
    if (sOT24) console.log(`  Ops last 24h:       ${sOT24.reduce((a, b) => a + b, 0)} (peak/h: ${Math.max(...sOT24)})`); // T699
    const sBT24 = (s as Record<string, unknown>)['blockTrend24h'] as number[] | undefined;
    if (sBT24) console.log(`  Blocks last 24h:    ${sBT24.reduce((a, b) => a + b, 0)}`); // T700
    const sRT24 = (s as Record<string, unknown>)['avgRiskTrend24h'] as Array<number | null> | undefined;
    if (sRT24) { const vals = sRT24.filter((v): v is number => v !== null); if (vals.length > 0) console.log(`  Avg risk 24h:       ${(vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1)}%`); } // T701
    const sMD = (s as Record<string, unknown>)['methodDiversity'] as number | undefined;
    if (sMD !== undefined) console.log(`  Method diversity:   ${sMD.toFixed(3)}`); // T702
    const sTD2 = (s as Record<string, unknown>)['toolDiversity'] as number | undefined;
    if (sTD2 !== undefined) console.log(`  Tool diversity:     ${sTD2.toFixed(3)}`); // T703
    const sHRH = (s as Record<string, unknown>)['highRiskHourCount'] as number | undefined;
    if (sHRH !== undefined && sHRH > 0) console.log(`  High-risk hours:    ${sHRH}/24`); // T704
    const sZOH = (s as Record<string, unknown>)['zeroOpsHourCount'] as number | undefined;
    if (sZOH !== undefined) console.log(`  Zero-ops hours:     ${sZOH}/24`); // T705
    const sBSH = (s as Record<string, unknown>)['blockSpikeHour'] as number | null | undefined;
    if (sBSH != null) console.log(`  Block spike hour:   ${sBSH} hrs ago`); // T706
    const sOSH = (s as Record<string, unknown>)['opsSpikeHour'] as number | null | undefined;
    if (sOSH != null) console.log(`  Ops spike hour:     ${sOSH} hrs ago`); // T707
    const sRV_b = (s as Record<string, unknown>)['riskVolatility'] as number | null | undefined;
    if (sRV_b != null) console.log(`  Risk volatility:    ${(sRV_b * 100).toFixed(1)}%`); // T708
    const sCOC = (s as Record<string, unknown>)['criticalOpsCount'] as number | undefined;
    if (sCOC !== undefined && sCOC > 0) console.log(`  Critical ops (≥0.9): ${sCOC}`); // T709
    const sARBA = (s as Record<string, unknown>)['avgRiskByAction'] as Record<string, number> | undefined;
    if (sARBA) console.log(`  Avg risk by action: allow=${(sARBA['allow']!*100).toFixed(0)}% block=${(sARBA['block']!*100).toFixed(0)}% pending=${(sARBA['require_approval']!*100).toFixed(0)}%`); // T710
    const sRAI = (s as Record<string, unknown>)['recentAgentIds'] as string[] | undefined;
    if (sRAI && sRAI.length > 0) console.log(`  Recent agents:      ${sRAI.slice(0,3).join(', ')}`); // T711
    const sOD = (s as Record<string, unknown>)['opsDensity'] as number | null | undefined;
    if (sOD != null) console.log(`  Ops density:        ${sOD.toFixed(1)}/h`); // T713
    const sBFS = (s as Record<string, unknown>)['blockFreeStreak'] as number | undefined;
    if (sBFS != null && sBFS > 0) console.log(`  Block-free streak:  ${sBFS} ops`); // T714
    const sHRFS = (s as Record<string, unknown>)['highRiskFreeStreak'] as number | undefined;
    if (sHRFS != null && sHRFS > 0) console.log(`  Low-risk streak:    ${sHRFS} ops`); // T715
    const sAOBB = (s as Record<string, unknown>)['avgOpsBetweenBlocks'] as number | null | undefined;
    if (sAOBB != null) console.log(`  Avg ops/block gap:  ${sAOBB.toFixed(1)}`); // T716
    const sRRT = (s as Record<string, unknown>)['recentRiskTrend'] as string | undefined;
    if (sRRT) console.log(`  Recent risk trend:  ${sRRT}`); // T717
    const sCS = (s as Record<string, unknown>)['coverageScore'] as number | undefined;
    if (sCS != null) console.log(`  24h coverage:       ${(sCS * 100).toFixed(0)}%`); // T718
    const sPHOD = (s as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (sPHOD != null) console.log(`  Peak hour:          h-${sPHOD}`); // T719
    const sQHOD = (s as Record<string, unknown>)['quietHourOfDay'] as number | null | undefined;
    if (sQHOD != null) console.log(`  Quiet hour:         h-${sQHOD}`); // T720
    const sBRL_b = (s as Record<string, unknown>)['blockRunLengthMax'] as number | undefined;
    if (sBRL_b != null && sBRL_b > 0) console.log(`  Max block run:      ${sBRL_b}`); // T721
    const sARL = (s as Record<string, unknown>)['allowRunLengthMax'] as number | undefined;
    if (sARL != null && sARL > 0) console.log(`  Max allow run:      ${sARL}`); // T722
    const sRIQR = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (sRIQR != null) console.log(`  Risk IQR:           ${sRIQR.toFixed(3)}`); // T723
    const sMR = (s as Record<string, unknown>)['medianRisk'] as number | null | undefined;
    if (sMR != null) console.log(`  Median risk:        ${sMR.toFixed(3)}`); // T724
    const sP90 = (s as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (sP90 != null) console.log(`  P90 risk:           ${sP90.toFixed(3)}`); // T725
    const sBRLH = (s as Record<string, unknown>)['blockRateLastHour'] as number | null | undefined;
    if (sBRLH != null) console.log(`  Block rate (1h):    ${(sBRLH * 100).toFixed(1)}%`); // T726
    const sARLH = (s as Record<string, unknown>)['approvalRateLastHour'] as number | null | undefined;
    if (sARLH != null) console.log(`  Approval rate (1h): ${(sARLH * 100).toFixed(1)}%`); // T727
    const sUTC = (s as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
    if (sUTC != null) console.log(`  Unique tools:       ${sUTC}`); // T728
    const sRSD = (s as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (sRSD != null) console.log(`  Risk std dev:       ${sRSD.toFixed(3)}`); // T729
    const sFOT = (s as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (sFOT) console.log(`  First op:           ${sFOT}`); // T730
    const sLOT = (s as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (sLOT) console.log(`  Last op:            ${sLOT}`); // T731
    const sTBT = (s as Record<string, unknown>)['topBlockedTool'] as string | null | undefined;
    if (sTBT) console.log(`  Top blocked tool:   ${sTBT}`); // T732
    const sARL10 = (s as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (sARL10 != null) console.log(`  Avg risk (last 10): ${sARL10.toFixed(3)}`); // T733
    const sBRLD = (s as Record<string, unknown>)['blockRateLastDay'] as number | null | undefined;
    if (sBRLD != null) console.log(`  Block rate (24h):   ${(sBRLD * 100).toFixed(1)}%`); // T734
    const sTAT = (s as Record<string, unknown>)['topAllowedTool'] as string | null | undefined;
    if (sTAT) console.log(`  Top allowed tool:   ${sTAT}`); // T735
    const sRBOI = (s as Record<string, unknown>)['recentBlockedOpIds'] as string[] | undefined;
    if (sRBOI && sRBOI.length > 0) console.log(`  Recent blocked ops: ${sRBOI.map(id => id.slice(0,8)).join(', ')}`); // T736
    const sRAOI = (s as Record<string, unknown>)['recentApprovedOpIds'] as string[] | undefined;
    if (sRAOI && sRAOI.length > 0) console.log(`  Recent pending ops: ${sRAOI.map(id => id.slice(0,8)).join(', ')}`); // T737
    const sAgentC = (s as Record<string, unknown>)['agentCount'] as number | undefined;
    if (sAgentC != null) console.log(`  Distinct agents:    ${sAgentC}`); // T738
    const sMinR = (s as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (sMinR != null) console.log(`  Min risk:           ${sMinR.toFixed(3)}`); // T739
    const sMaxR = (s as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (sMaxR != null) console.log(`  Max risk:           ${sMaxR.toFixed(3)}`); // T740
    const sARF10 = (s as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (sARF10 != null) console.log(`  Avg risk (first 10):${sARF10.toFixed(3)}`); // T741
    const sRDFL = (s as Record<string, unknown>)['riskDeltaFirstLast'] as number | null | undefined;
    if (sRDFL != null) console.log(`  Risk delta F→L:     ${sRDFL >= 0 ? '+' : ''}${sRDFL.toFixed(3)}`); // T742
    const sAM = (s as Record<string, unknown>)['activeMinutes'] as number | null | undefined;
    if (sAM != null) console.log(`  Active span:        ${sAM.toFixed(1)}m`); // T743
    const sRSkew = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (sRSkew != null) console.log(`  Risk skewness:      ${sRSkew.toFixed(3)}`); // T744
    const sOB5 = (s as Record<string, unknown>)['opsBurst5m'] as number | undefined;
    if (sOB5 != null) console.log(`  Ops burst (5m):     ${sOB5}`); // T745
    const sBB5 = (s as Record<string, unknown>)['blockBurst5m'] as number | undefined;
    if (sBB5 != null && sBB5 > 0) console.log(`  Block burst (5m):   ${sBB5}`); // T746
    const sAIMs = (s as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (sAIMs != null) console.log(`  Avg interval:       ${(sAIMs/1000).toFixed(1)}s`); // T747
    const sLGMs = (s as Record<string, unknown>)['longestGapMs'] as number | null | undefined;
    if (sLGMs != null) console.log(`  Longest gap:        ${(sLGMs/1000).toFixed(1)}s`); // T748
    const sKurt = (s as Record<string, unknown>)['kurtosis'] as number | null | undefined;
    if (sKurt != null) console.log(`  Kurtosis:           ${sKurt.toFixed(3)}`); // T749
    const sCHRM = (s as Record<string, unknown>)['consecutiveHighRiskMax'] as number | undefined;
    if (sCHRM != null && sCHRM > 0) console.log(`  Max hi-risk streak: ${sCHRM}`); // T753
    const sCLRM = (s as Record<string, unknown>)['consecutiveLowRiskMax'] as number | undefined;
    if (sCLRM != null && sCLRM > 0) console.log(`  Max lo-risk streak: ${sCLRM}`); // T751
    const sRBF = (s as Record<string, unknown>)['riskBucketsFine'] as number[] | undefined;
    if (sRBF && sRBF.some(v => v > 0)) console.log(`  Risk buckets(fine): ${sRBF.join('|')}`); // T752
    const sRWBR = (s as Record<string, unknown>)['riskWeightedBlockRate'] as number | null | undefined;
    if (sRWBR != null) console.log(`  Risk-wtd blk rate:  ${(sRWBR*100).toFixed(1)}%`); // T754
    const sAPC = (s as Record<string, unknown>)['approvalPendingCount'] as number | undefined;
    if (sAPC != null && sAPC > 0) console.log(`  Pending approvals:  ${sAPC}`); // T755
    const sTMBO = (s as Record<string, unknown>)['topMethodByOps'] as string | null | undefined;
    if (sTMBO) console.log(`  Top method (ops):   ${sTMBO}`); // T756
    const sTMBR = (s as Record<string, unknown>)['topMethodByRisk'] as string | null | undefined;
    if (sTMBR) console.log(`  Top method (risk):  ${sTMBR}`); // T757
    const sR99 = (s as Record<string, unknown>)['riskScore99p'] as number | null | undefined;
    if (sR99 != null) console.log(`  P99 risk:           ${sR99.toFixed(3)}`); // T758
    const sUMC_b = (s as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (sUMC_b != null) console.log(`  Unique methods:     ${sUMC_b}`); // T759
    const sR10 = (s as Record<string, unknown>)['riskScore10p'] as number | null | undefined;
    if (sR10 != null) console.log(`  P10 risk:           ${sR10.toFixed(3)}`); // T762
    const sR75 = (s as Record<string, unknown>)['riskScore75p'] as number | null | undefined;
    if (sR75 != null) console.log(`  P75 risk:           ${sR75.toFixed(3)}`); // T763
    const sR25 = (s as Record<string, unknown>)['riskScore25p'] as number | null | undefined;
    if (sR25 != null) console.log(`  P25 risk:           ${sR25.toFixed(3)}`); // T766
    const sREB = (s as Record<string, unknown>)['riskEntropyBuckets'] as number | undefined;
    if (sREB != null) console.log(`  Risk entropy:       ${sREB.toFixed(3)}`); // T767
    const sART = (s as Record<string, unknown>)['avgRiskByTool'] as Record<string, number> | undefined;
    if (sART && Object.keys(sART).length > 0) { const top3 = Object.entries(sART).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${(v*100).toFixed(0)}%`).join(' '); console.log(`  Avg risk/tool:      ${top3}`); } // T768
    const sBCT = (s as Record<string, unknown>)['blockCountByTool'] as Record<string, number> | undefined;
    if (sBCT && Object.keys(sBCT).length > 0) { const top3 = Object.entries(sBCT).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Blocks/tool:        ${top3}`); } // T769
    const sACT = (s as Record<string, unknown>)['allowCountByTool'] as Record<string, number> | undefined;
    if (sACT && Object.keys(sACT).length > 0) { const top3 = Object.entries(sACT).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Allows/tool:        ${top3}`); } // T770
    const sOL5 = (s as Record<string, unknown>)['opsLast5m'] as number | undefined;
    if (sOL5 != null) console.log(`  Ops last 5m:        ${sOL5}`); // T771
    const sBL5 = (s as Record<string, unknown>)['blocksLast5m'] as number | undefined;
    if (sBL5 != null) console.log(`  Blocks last 5m:     ${sBL5}`); // T772
    const sHRI = (s as Record<string, unknown>)['highRiskOpIds'] as string[] | undefined;
    if (sHRI && sHRI.length > 0) console.log(`  High risk op IDs:   ${sHRI.slice(0, 3).join(' ')}`); // T773
    const sARP = (s as Record<string, unknown>)['approvalRatePercent'] as number | null | undefined;
    if (sARP != null) console.log(`  Approval rate:      ${sARP.toFixed(1)}%`); // T774
    const sRCR = (s as Record<string, unknown>)['riskChangeRate'] as number | null | undefined;
    if (sRCR != null) console.log(`  Risk change rate:   ${sRCR.toFixed(3)}`); // T775
    const sDD = (s as Record<string, unknown>)['decisionDistribution'] as Record<string, number> | undefined;
    if (sDD) console.log(`  Decisions:          allow=${sDD['allow']} block=${sDD['block']} approval=${sDD['require_approval']}`); // T776
    const sOT = (s as Record<string, unknown>)['opsTrend12h'] as number | null | undefined;
    if (sOT != null) console.log(`  Ops trend 12h:      ${sOT.toFixed(2)}x`); // T777
    const sARB = (s as Record<string, unknown>)['avgRiskOfBlocked'] as number | null | undefined;
    if (sARB != null) console.log(`  Avg risk blocked:   ${sARB.toFixed(3)}`); // T778
    const sARA = (s as Record<string, unknown>)['avgRiskOfAllowed'] as number | null | undefined;
    if (sARA != null) console.log(`  Avg risk allowed:   ${sARA.toFixed(3)}`); // T779
    const sRGB = (s as Record<string, unknown>)['riskGapBlockVsAllow'] as number | null | undefined;
    if (sRGB != null) console.log(`  Risk gap b-a:       ${sRGB.toFixed(3)}`); // T780
    const sOL1 = (s as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (sOL1 != null) console.log(`  Ops last 1h:        ${sOL1}`); // T781
    const sBL1 = (s as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (sBL1 != null) console.log(`  Blocks last 1h:     ${sBL1}`); // T782
    const sBRO = (s as Record<string, unknown>)['blockRateOverall'] as number | null | undefined;
    if (sBRO != null) console.log(`  Block rate overall: ${(sBRO*100).toFixed(1)}%`); // T783
    const sARO = (s as Record<string, unknown>)['allowRateOverall'] as number | null | undefined;
    if (sARO != null) console.log(`  Allow rate overall: ${(sARO*100).toFixed(1)}%`); // T784
    const sACO = (s as Record<string, unknown>)['approvalCountOverall'] as number | undefined;
    if (sACO != null) console.log(`  Approval count:     ${sACO}`); // T785
    const sRB = (s as Record<string, unknown>)['riskBand'] as string | undefined;
    if (sRB) console.log(`  Risk band:          ${sRB}`); // T786
    const sRAI_b = (s as Record<string, unknown>)['recentAllowedOpIds'] as string[] | undefined;
    if (sRAI_b && sRAI_b.length > 0) console.log(`  Recent allow IDs:   ${sRAI_b.slice(0, 3).join(' ')}`); // T787
    const sP95 = (s as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (sP95 != null) console.log(`  P95 risk:           ${sP95.toFixed(3)}`); // T788
    const sRCV = (s as Record<string, unknown>)['riskCV'] as number | null | undefined;
    if (sRCV != null) console.log(`  Risk CV:            ${sRCV.toFixed(3)}`); // T789
    const sBSC = (s as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (sBSC != null && sBSC > 0) console.log(`  Block streak now:   ${sBSC}`); // T790
    const sASC = (s as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (sASC != null && sASC > 0) console.log(`  Allow streak now:   ${sASC}`); // T791
    const sRM = (s as Record<string, unknown>)['riskMomentum'] as number | null | undefined;
    if (sRM != null) console.log(`  Risk momentum:      ${sRM.toFixed(3)}`); // T792
    const sOPA = (s as Record<string, unknown>)['opsPerAgent'] as number | null | undefined;
    if (sOPA != null) console.log(`  Ops per agent:      ${sOPA.toFixed(1)}`); // T793
    const sOPT = (s as Record<string, unknown>)['opsPerTool'] as number | null | undefined;
    if (sOPT != null) console.log(`  Ops per tool:       ${sOPT.toFixed(1)}`); // T794
    const sHRBC = (s as Record<string, unknown>)['highRiskBlockCount'] as number | undefined;
    if (sHRBC != null) console.log(`  High-risk blocks:   ${sHRBC}`); // T796
    const sLRAC = (s as Record<string, unknown>)['lowRiskAllowCount'] as number | undefined;
    if (sLRAC != null) console.log(`  Low-risk allows:    ${sLRAC}`); // T797
    const sRTHD = (s as Record<string, unknown>)['riskTrendHalfDay'] as number | null | undefined;
    if (sRTHD != null) console.log(`  Risk trend 12h:     ${sRTHD > 0 ? '+' : ''}${sRTHD.toFixed(3)}`); // T798
    const sMIM = (s as Record<string, unknown>)['medianIntervalMs'] as number | null | undefined;
    if (sMIM != null) console.log(`  Median interval:    ${sMIM.toFixed(0)}ms`); // T799
    const sBRL6 = (s as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (sBRL6 != null) console.log(`  Block rate 6h:      ${(sBRL6*100).toFixed(1)}%`); // T800
    const sARL6 = (s as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (sARL6 != null) console.log(`  Allow rate 6h:      ${(sARL6*100).toFixed(1)}%`); // T801
    const sRDS = (s as Record<string, unknown>)['riskDecayScore'] as number | null | undefined;
    if (sRDS != null) console.log(`  Risk decay score:   ${sRDS.toFixed(3)}`); // T802
    const sROI = (s as Record<string, unknown>)['recentOpIds'] as string[] | undefined;
    if (sROI && sROI.length > 0) console.log(`  Recent op IDs:      ${sROI.slice(0, 3).join(' ')}`); // T803
    const sBRL3 = (s as Record<string, unknown>)['blockRateLast3h'] as number | null | undefined;
    if (sBRL3 != null) console.log(`  Block rate 3h:      ${(sBRL3*100).toFixed(1)}%`); // T804
    const sARL3 = (s as Record<string, unknown>)['allowRateLast3h'] as number | null | undefined;
    if (sARL3 != null) console.log(`  Allow rate 3h:      ${(sARL3*100).toFixed(1)}%`); // T805
    const sOL3 = (s as Record<string, unknown>)['opsLast3h'] as number | undefined;
    if (sOL3 != null) console.log(`  Ops last 3h:        ${sOL3}`); // T806
    const sTABO = (s as Record<string, unknown>)['topAgentByOps'] as string | null | undefined;
    if (sTABO) console.log(`  Top agent (ops):    ${sTABO}`); // T807
    const sTABR = (s as Record<string, unknown>)['topAgentByRisk'] as string | null | undefined;
    if (sTABR) console.log(`  Top agent (risk):   ${sTABR}`); // T808
    const sTTBO = (s as Record<string, unknown>)['topToolByOps'] as string | null | undefined;
    if (sTTBO) console.log(`  Top tool (ops):     ${sTTBO}`); // T809
    const sTTBR = (s as Record<string, unknown>)['topToolByRisk'] as string | null | undefined;
    if (sTTBR) console.log(`  Top tool (risk):    ${sTTBR}`); // T810
    const sBCL24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (sBCL24 != null) console.log(`  Blocks last 24h:    ${sBCL24}`); // T811
    const sACL24 = (s as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (sACL24 != null) console.log(`  Allows last 24h:    ${sACL24}`); // T812
    const sAPCL24 = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (sAPCL24 != null) console.log(`  Approvals last 24h: ${sAPCL24}`); // T813
    const sRAMC = (s as Record<string, unknown>)['riskAboveMedianCount'] as number | undefined;
    if (sRAMC != null) console.log(`  Risk above median:  ${sRAMC}`); // T814
    const sRBMC = (s as Record<string, unknown>)['riskBelowMedianCount'] as number | undefined;
    if (sRBMC != null) console.log(`  Risk below median:  ${sRBMC}`); // T815
    const sBD = (s as Record<string, unknown>)['blockDensity'] as number | null | undefined;
    if (sBD != null) console.log(`  Block density:      ${sBD.toFixed(1)}/1k`); // T816
    const sAD = (s as Record<string, unknown>)['approvalDensity'] as number | null | undefined;
    if (sAD != null) console.log(`  Approval density:   ${sAD.toFixed(1)}/1k`); // T817
    const sRVR = (s as Record<string, unknown>)['riskVolatilityRecent'] as number | null | undefined;
    if (sRVR != null) console.log(`  Risk vol (recent):  ${sRVR.toFixed(3)}`); // T818
    const sRHBC = (s as Record<string, unknown>)['riskHighBandCount'] as number | undefined;
    if (sRHBC != null) console.log(`  Risk high (>=0.7):  ${sRHBC}`); // T819
    const sRLBC = (s as Record<string, unknown>)['riskLowBandCount'] as number | undefined;
    if (sRLBC != null) console.log(`  Risk low (<0.3):    ${sRLBC}`); // T820
    const sRMBC = (s as Record<string, unknown>)['riskMidBandCount'] as number | undefined;
    if (sRMBC != null) console.log(`  Risk mid (0.3-0.7): ${sRMBC}`); // T821
    const sHSFO = (s as Record<string, unknown>)['hoursSinceFirstOp'] as number | null | undefined;
    if (sHSFO != null) console.log(`  Hours since 1st op: ${sHSFO.toFixed(1)}`); // T822
    const sHSLO = (s as Record<string, unknown>)['hoursSinceLastOp'] as number | null | undefined;
    if (sHSLO != null) console.log(`  Hours since last op:${sHSLO.toFixed(1)}`); // T823
    const sOL30 = (s as Record<string, unknown>)['opsLast30m'] as number | undefined;
    if (sOL30 != null) console.log(`  Ops last 30m:       ${sOL30}`); // T824
    const sBL30 = (s as Record<string, unknown>)['blocksLast30m'] as number | undefined;
    if (sBL30 != null) console.log(`  Blocks last 30m:    ${sBL30}`); // T825
    const sTSO = (s as Record<string, unknown>)['topSessionByOps'] as string | null | undefined;
    if (sTSO != null) console.log(`  Top sess (ops):     ${sTSO}`); // T826
    const sTSR = (s as Record<string, unknown>)['topSessionByRisk'] as string | null | undefined;
    if (sTSR != null) console.log(`  Top sess (risk):    ${sTSR}`); // T827
    const sUSC = (s as Record<string, unknown>)['uniqueSessionCount'] as number | undefined;
    if (sUSC != null) console.log(`  Unique sessions:    ${sUSC}`); // T828
    const sUAC = (s as Record<string, unknown>)['uniqueAgentCount'] as number | undefined;
    if (sUAC != null) console.log(`  Unique agents:      ${sUAC}`); // T829
    const sUTC_b = (s as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
    if (sUTC_b != null) console.log(`  Unique tools:       ${sUTC_b}`); // T830
    const sAOS = (s as Record<string, unknown>)['avgOpsPerSession'] as number | null | undefined;
    if (sAOS != null) console.log(`  Avg ops/session:    ${sAOS.toFixed(1)}`); // T831
    const sTTB = (s as Record<string, unknown>)['topToolByBlocks'] as string | null | undefined;
    if (sTTB != null) console.log(`  Top tool (blocks):  ${sTTB}`); // T832
    const sTAB = (s as Record<string, unknown>)['topAgentByBlocks'] as string | null | undefined;
    if (sTAB != null) console.log(`  Top agent (blocks): ${sTAB}`); // T833
    const sBRL24 = (s as Record<string, unknown>)['blockRateLast24h'] as number | null | undefined;
    if (sBRL24 != null) console.log(`  Block rate 24h:     ${(sBRL24 * 100).toFixed(1)}%`); // T834
    const sARL24 = (s as Record<string, unknown>)['allowRateLast24h'] as number | null | undefined;
    if (sARL24 != null) console.log(`  Allow rate 24h:     ${(sARL24 * 100).toFixed(1)}%`); // T835
    const sAPRL24 = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (sAPRL24 != null) console.log(`  Approval rate 24h:  ${(sAPRL24 * 100).toFixed(1)}%`); // T836
    const sMCB = (s as Record<string, unknown>)['maxConsecutiveBlocks'] as number | undefined;
    if (sMCB != null) console.log(`  Max consec blocks:  ${sMCB}`); // T837
    const sMCA = (s as Record<string, unknown>)['maxConsecutiveAllows'] as number | undefined;
    if (sMCA != null) console.log(`  Max consec allows:  ${sMCA}`); // T838
    const sRSK = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (sRSK != null) console.log(`  Risk skewness:      ${sRSK.toFixed(3)}`); // T839
    const sRKT = (s as Record<string, unknown>)['riskKurtosis'] as number | null | undefined;
    if (sRKT != null) console.log(`  Risk kurtosis:      ${sRKT.toFixed(3)}`); // T840
    const sOL15 = (s as Record<string, unknown>)['opsLast15m'] as number | undefined;
    if (sOL15 != null) console.log(`  Ops last 15m:       ${sOL15}`); // T841
    const sBL15 = (s as Record<string, unknown>)['blocksLast15m'] as number | undefined;
    if (sBL15 != null) console.log(`  Blocks last 15m:    ${sBL15}`); // T842
    const sHRR_b = (s as Record<string, unknown>)['highRiskRateOverall'] as number | null | undefined;
    if (sHRR_b != null) console.log(`  High-risk rate:     ${(sHRR_b * 100).toFixed(1)}%`); // T843
    const sLRR_b = (s as Record<string, unknown>)['lowRiskRateOverall'] as number | null | undefined;
    if (sLRR_b != null) console.log(`  Low-risk rate:      ${(sLRR_b * 100).toFixed(1)}%`); // T844
    const sMRR_b = (s as Record<string, unknown>)['midRiskRateOverall'] as number | null | undefined;
    if (sMRR_b != null) console.log(`  Mid-risk rate:      ${(sMRR_b * 100).toFixed(1)}%`); // T845
    const sRRG = (s as Record<string, unknown>)['riskRange'] as number | null | undefined;
    if (sRRG != null) console.log(`  Risk range:         ${sRRG.toFixed(3)}`); // T846
    const sFOT_b = (s as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (sFOT_b != null) console.log(`  First op at:        ${sFOT_b}`); // T847
    const sLOT_b = (s as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (sLOT_b != null) console.log(`  Last op at:         ${sLOT_b}`); // T848
    const sTDMs = (s as Record<string, unknown>)['totalDurationMs'] as number | null | undefined;
    if (sTDMs != null) console.log(`  Total duration:     ${(sTDMs / 3600000).toFixed(1)}h`); // T849
    const sOPH = (s as Record<string, unknown>)['opsPerHour'] as number | null | undefined;
    if (sOPH != null) console.log(`  Ops per hour:       ${sOPH.toFixed(1)}`); // T850
    const sBPH = (s as Record<string, unknown>)['blocksPerHour'] as number | null | undefined;
    if (sBPH != null) console.log(`  Blocks per hour:    ${sBPH.toFixed(1)}`); // T851
    const sRWBC = (s as Record<string, unknown>)['riskWeightedBlockCount'] as number | undefined;
    if (sRWBC != null) console.log(`  Risk-wtd blocks:    ${sRWBC.toFixed(2)}`); // T852
    const sRWAC = (s as Record<string, unknown>)['riskWeightedAllowCount'] as number | undefined;
    if (sRWAC != null) console.log(`  Risk-wtd allows:    ${sRWAC.toFixed(2)}`); // T853
    const sARL10_b = (s as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (sARL10_b != null) console.log(`  Avg risk last 10:   ${sARL10_b.toFixed(3)}`); // T854
    const sARF10_b = (s as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (sARF10_b != null) console.log(`  Avg risk first 10:  ${sARF10_b.toFixed(3)}`); // T855
    const sRTF10 = (s as Record<string, unknown>)['riskTrendFirst10vsLast10'] as number | null | undefined;
    if (sRTF10 != null) console.log(`  Risk trend (10):    ${sRTF10 >= 0 ? '+' : ''}${sRTF10.toFixed(3)}`); // T856
    const sBCL7 = (s as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (sBCL7 != null) console.log(`  Blocks last 7d:     ${sBCL7}`); // T857
    const sACL7 = (s as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (sACL7 != null) console.log(`  Allows last 7d:     ${sACL7}`); // T858
    const sAPCL7 = (s as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (sAPCL7 != null) console.log(`  Approvals last 7d:  ${sAPCL7}`); // T859
    const sOCL7 = (s as Record<string, unknown>)['opsCountLast7d'] as number | undefined;
    if (sOCL7 != null) console.log(`  Ops last 7d:        ${sOCL7}`); // T860
    const sRSA = (s as Record<string, unknown>)['riskSumAll'] as number | undefined;
    if (sRSA != null) console.log(`  Risk sum (all):     ${sRSA.toFixed(2)}`); // T861
    const sAIM = (s as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (sAIM != null) console.log(`  Avg interval:       ${(sAIM / 1000).toFixed(1)}s`); // T862
    const sMNR = (s as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (sMNR != null) console.log(`  Min risk:           ${sMNR.toFixed(3)}`); // T863
    const sMXR = (s as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (sMXR != null) console.log(`  Max risk:           ${sMXR.toFixed(3)}`); // T864
    const sRIQR_b = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (sRIQR_b != null) console.log(`  Risk IQR:           ${sRIQR_b.toFixed(3)}`); // T865
    const sBRC1 = (s as Record<string, unknown>)['blockRateChange1h'] as number | undefined;
    if (sBRC1 != null) console.log(`  Block rate Δ1h:     ${sBRC1 >= 0 ? '+' : ''}${(sBRC1 * 100).toFixed(1)}%`); // T866
    const sOT1 = (s as Record<string, unknown>)['opsTrend1h'] as number | null | undefined;
    if (sOT1 != null) console.log(`  Ops trend 1h:       ${sOT1.toFixed(2)}x`); // T867
    const sBT6 = (s as Record<string, unknown>)['blockTrend6h'] as number | null | undefined;
    if (sBT6 != null) console.log(`  Block trend 6h:     ${sBT6.toFixed(2)}x`); // T868
    const sAT6 = (s as Record<string, unknown>)['allowTrend6h'] as number | null | undefined;
    if (sAT6 != null) console.log(`  Allow trend 6h:     ${sAT6.toFixed(2)}x`); // T869
    const sBRA = (s as Record<string, unknown>)['blockRatioToAllow'] as number | null | undefined;
    if (sBRA != null) console.log(`  Block/allow ratio:  ${sBRA.toFixed(2)}`); // T870
    const sARB_b = (s as Record<string, unknown>)['approvalRatioToBlock'] as number | null | undefined;
    if (sARB_b != null) console.log(`  Approval/block:     ${sARB_b.toFixed(2)}`); // T871
    const sOL2 = (s as Record<string, unknown>)['opsLast2h'] as number | undefined;
    if (sOL2 != null) console.log(`  Ops last 2h:        ${sOL2}`); // T872
    const sBL2 = (s as Record<string, unknown>)['blocksLast2h'] as number | undefined;
    if (sBL2 != null) console.log(`  Blocks last 2h:     ${sBL2}`); // T873
    const sAL2 = (s as Record<string, unknown>)['allowsLast2h'] as number | undefined;
    if (sAL2 != null) console.log(`  Allows last 2h:     ${sAL2}`); // T874
    const sOL4 = (s as Record<string, unknown>)['opsLast4h'] as number | undefined;
    if (sOL4 != null) console.log(`  Ops last 4h:        ${sOL4}`); // T875
    const sBL4 = (s as Record<string, unknown>)['blocksLast4h'] as number | undefined;
    if (sBL4 != null) console.log(`  Blocks last 4h:     ${sBL4}`); // T876
    const sBR4 = (s as Record<string, unknown>)['blockRateLast4h'] as number | null | undefined;
    if (sBR4 != null) console.log(`  Block rate 4h:      ${(sBR4 * 100).toFixed(1)}%`); // T877
    const sRSD_b = (s as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (sRSD_b != null) console.log(`  Risk std dev:       ${sRSD_b.toFixed(3)}`); // T878
    const sAL4 = (s as Record<string, unknown>)['allowsLast4h'] as number | undefined;
    if (sAL4 != null) console.log(`  Allows last 4h:     ${sAL4}`); // T879
    const sAR4 = (s as Record<string, unknown>)['allowRateLast4h'] as number | null | undefined;
    if (sAR4 != null) console.log(`  Allow rate 4h:      ${(sAR4 * 100).toFixed(1)}%`); // T880
    const sOL12 = (s as Record<string, unknown>)['opsLast12h'] as number | undefined;
    if (sOL12 != null) console.log(`  Ops last 12h:       ${sOL12}`); // T881
    const sBL12 = (s as Record<string, unknown>)['blocksLast12h'] as number | undefined;
    if (sBL12 != null) console.log(`  Blocks last 12h:    ${sBL12}`); // T882
    const sAL12 = (s as Record<string, unknown>)['allowsLast12h'] as number | undefined;
    if (sAL12 != null) console.log(`  Allows last 12h:    ${sAL12}`); // T883
    const sBR12 = (s as Record<string, unknown>)['blockRateLast12h'] as number | null | undefined;
    if (sBR12 != null) console.log(`  Block rate 12h:     ${(sBR12 * 100).toFixed(1)}%`); // T884
    const sAR12 = (s as Record<string, unknown>)['allowRateLast12h'] as number | null | undefined;
    if (sAR12 != null) console.log(`  Allow rate 12h:     ${(sAR12 * 100).toFixed(1)}%`); // T885
    const sOL48 = (s as Record<string, unknown>)['opsLast48h'] as number | undefined;
    if (sOL48 != null) console.log(`  Ops last 48h:       ${sOL48}`); // T886
    const sBL48 = (s as Record<string, unknown>)['blocksLast48h'] as number | undefined;
    if (sBL48 != null) console.log(`  Blocks last 48h:    ${sBL48}`); // T887
    const sAL48 = (s as Record<string, unknown>)['allowsLast48h'] as number | undefined;
    if (sAL48 != null) console.log(`  Allows last 48h:    ${sAL48}`); // T888
    const sBR48 = (s as Record<string, unknown>)['blockRateLast48h'] as number | null | undefined;
    if (sBR48 != null) console.log(`  Block rate 48h:     ${(sBR48 * 100).toFixed(1)}%`); // T889
    const sAR48 = (s as Record<string, unknown>)['allowRateLast48h'] as number | null | undefined;
    if (sAR48 != null) console.log(`  Allow rate 48h:     ${(sAR48 * 100).toFixed(1)}%`); // T890
    const sAPC24 = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (sAPC24 != null) console.log(`  Approvals last 24h: ${sAPC24}`); // T891
    const sAPR24 = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (sAPR24 != null) console.log(`  Approval rate 24h:  ${(sAPR24 * 100).toFixed(1)}%`); // T892
    const sRCV_b = (s as Record<string, unknown>)['riskCvPct'] as number | null | undefined;
    if (sRCV_b != null) console.log(`  Risk CV%:           ${sRCV_b.toFixed(1)}%`); // T893
    const sAPC48 = (s as Record<string, unknown>)['approvalCountLast48h'] as number | undefined;
    if (sAPC48 != null) console.log(`  Approvals last 48h: ${sAPC48}`); // T894
    const sAPC12 = (s as Record<string, unknown>)['approvalCountLast12h'] as number | undefined;
    if (sAPC12 != null) console.log(`  Approvals last 12h: ${sAPC12}`); // T895
    const sP50 = (s as Record<string, unknown>)['p50Risk'] as number | null | undefined;
    if (sP50 != null) console.log(`  Risk p50:           ${sP50.toFixed(3)}`); // T896
    const sP90_b = (s as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (sP90_b != null) console.log(`  Risk p90:           ${sP90_b.toFixed(3)}`); // T897
    const sP10 = (s as Record<string, unknown>)['p10Risk'] as number | null | undefined;
    if (sP10 != null) console.log(`  Risk p10:           ${sP10.toFixed(3)}`); // T898
    const sBC30d = (s as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (sBC30d != null) console.log(`  Blocks last 30d:    ${sBC30d}`); // T899
    const sAC30d = (s as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (sAC30d != null) console.log(`  Allows last 30d:    ${sAC30d}`); // T900
    const sOL30d = (s as Record<string, unknown>)['opsLast30d'] as number | undefined;
    if (sOL30d != null) console.log(`  Ops last 30d:       ${sOL30d}`); // T901
    const sBR30d = (s as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (sBR30d != null) console.log(`  Block rate 30d:     ${(sBR30d * 100).toFixed(1)}%`); // T902
    const sAR30d = (s as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (sAR30d != null) console.log(`  Avg risk 30d:       ${sAR30d.toFixed(3)}`); // T903
    const sAPR48 = (s as Record<string, unknown>)['approvalRateLast48h'] as number | null | undefined;
    if (sAPR48 != null) console.log(`  Approval rate 48h:  ${(sAPR48 * 100).toFixed(1)}%`); // T904
    const sAPR12 = (s as Record<string, unknown>)['approvalRateLast12h'] as number | null | undefined;
    if (sAPR12 != null) console.log(`  Approval rate 12h:  ${(sAPR12 * 100).toFixed(1)}%`); // T905
    const sAPR30d = (s as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (sAPR30d != null) console.log(`  Approval rate 30d:  ${(sAPR30d * 100).toFixed(1)}%`); // T906
    const sHRC24 = (s as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (sHRC24 != null) console.log(`  High risk last 24h: ${sHRC24}`); // T907
    const sHRC7d = (s as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (sHRC7d != null) console.log(`  High risk last 7d:  ${sHRC7d}`); // T908
    const sHRC30d = (s as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (sHRC30d != null) console.log(`  High risk last 30d: ${sHRC30d}`); // T909
    const sLRC24 = (s as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (sLRC24 != null) console.log(`  Low risk last 24h:  ${sLRC24}`); // T910
    const sLRC7d = (s as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (sLRC7d != null) console.log(`  Low risk last 7d:   ${sLRC7d}`); // T911
    const sARL7d = (s as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (sARL7d != null) console.log(`  Avg risk 7d:        ${sARL7d.toFixed(3)}`); // T912
    const sARL24_b = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (sARL24_b != null) console.log(`  Avg risk 24h:       ${sARL24_b.toFixed(3)}`); // T913
    const sARL48 = (s as Record<string, unknown>)['avgRiskLast48h'] as number | null | undefined;
    if (sARL48 != null) console.log(`  Avg risk 48h:       ${sARL48.toFixed(3)}`); // T914
    const sARL12 = (s as Record<string, unknown>)['avgRiskLast12h'] as number | null | undefined;
    if (sARL12 != null) console.log(`  Avg risk 12h:       ${sARL12.toFixed(3)}`); // T915
    const sLRC30d = (s as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (sLRC30d != null) console.log(`  Low risk last 30d:  ${sLRC30d}`); // T916
    const sLRC48 = (s as Record<string, unknown>)['lowRiskCountLast48h'] as number | undefined;
    if (sLRC48 != null) console.log(`  Low risk last 48h:  ${sLRC48}`); // T917
    const sLRC12 = (s as Record<string, unknown>)['lowRiskCountLast12h'] as number | undefined;
    if (sLRC12 != null) console.log(`  Low risk last 12h:  ${sLRC12}`); // T918
    const sHRC48 = (s as Record<string, unknown>)['highRiskCountLast48h'] as number | undefined;
    if (sHRC48 != null) console.log(`  High risk last 48h: ${sHRC48}`); // T919
    const sHRC12 = (s as Record<string, unknown>)['highRiskCountLast12h'] as number | undefined;
    if (sHRC12 != null) console.log(`  High risk last 12h: ${sHRC12}`); // T920
    const sMRC24 = (s as Record<string, unknown>)['midRiskCountLast24h'] as number | undefined;
    if (sMRC24 != null) console.log(`  Mid risk last 24h:  ${sMRC24}`); // T921
    const sMRC7d = (s as Record<string, unknown>)['midRiskCountLast7d'] as number | undefined;
    if (sMRC7d != null) console.log(`  Mid risk last 7d:   ${sMRC7d}`); // T922
    const sMRC30d = (s as Record<string, unknown>)['midRiskCountLast30d'] as number | undefined;
    if (sMRC30d != null) console.log(`  Mid risk last 30d:  ${sMRC30d}`); // T923
    const sMRC48 = (s as Record<string, unknown>)['midRiskCountLast48h'] as number | undefined;
    if (sMRC48 != null) console.log(`  Mid risk last 48h:  ${sMRC48}`); // T924
    const sMRC12 = (s as Record<string, unknown>)['midRiskCountLast12h'] as number | undefined;
    if (sMRC12 != null) console.log(`  Mid risk last 12h:  ${sMRC12}`); // T925
    const sOL6 = (s as Record<string, unknown>)['opsLast6h'] as number | undefined;
    if (sOL6 != null) console.log(`  Ops last 6h:        ${sOL6}`); // T926
    const sBL6 = (s as Record<string, unknown>)['blocksLast6h'] as number | undefined;
    if (sBL6 != null) console.log(`  Blocks last 6h:     ${sBL6}`); // T927
    const sAL6 = (s as Record<string, unknown>)['allowsLast6h'] as number | undefined;
    if (sAL6 != null) console.log(`  Allows last 6h:     ${sAL6}`); // T928
    const sBR6 = (s as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (sBR6 != null) console.log(`  Block rate 6h:      ${(sBR6 * 100).toFixed(1)}%`); // T929
    const sAR6 = (s as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (sAR6 != null) console.log(`  Allow rate 6h:      ${(sAR6 * 100).toFixed(1)}%`); // T930
    const sAPC6 = (s as Record<string, unknown>)['approvalCountLast6h'] as number | undefined;
    if (sAPC6 != null) console.log(`  Approvals last 6h:  ${sAPC6}`); // T931
    const sARL6_b = (s as Record<string, unknown>)['avgRiskLast6h'] as number | null | undefined;
    if (sARL6_b != null) console.log(`  Avg risk 6h:        ${sARL6_b.toFixed(3)}`); // T932
    const sHRC6 = (s as Record<string, unknown>)['highRiskCountLast6h'] as number | undefined;
    if (sHRC6 != null) console.log(`  High risk last 6h:  ${sHRC6}`); // T933
    const sLRC6 = (s as Record<string, unknown>)['lowRiskCountLast6h'] as number | undefined;
    if (sLRC6 != null) console.log(`  Low risk last 6h:   ${sLRC6}`); // T934
    const sMRC6 = (s as Record<string, unknown>)['midRiskCountLast6h'] as number | undefined;
    if (sMRC6 != null) console.log(`  Mid risk last 6h:   ${sMRC6}`); // T935
    const sRV6 = (s as Record<string, unknown>)['riskVolatilityLast6h'] as number | null | undefined;
    if (sRV6 != null) console.log(`  Risk volatility 6h: ${sRV6.toFixed(3)}`); // T936
    const sBSC_b = (s as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (sBSC_b != null && sBSC_b > 0) console.log(`  Block streak:       ${sBSC_b}`); // T937
    const sASC_b = (s as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (sASC_b != null && sASC_b > 0) console.log(`  Allow streak:       ${sASC_b}`); // T938
    const sAPSC = (s as Record<string, unknown>)['approvalStreakCurrent'] as number | undefined;
    if (sAPSC != null && sAPSC > 0) console.log(`  Approval streak:    ${sAPSC}`); // T939
    const sRV24 = (s as Record<string, unknown>)['riskVolatilityLast24h'] as number | null | undefined;
    if (sRV24 != null) console.log(`  Risk volatility 24h:${sRV24.toFixed(3)}`); // T940
    const sRV7d = (s as Record<string, unknown>)['riskVolatilityLast7d'] as number | null | undefined;
    if (sRV7d != null) console.log(`  Risk volatility 7d: ${sRV7d.toFixed(3)}`); // T941
    const sBRL6_b = (s as Record<string, unknown>)['blockRatioLast6h'] as number | null | undefined;
    if (sBRL6_b != null) console.log(`  Block ratio 6h:     ${(sBRL6_b * 100).toFixed(1)}%`); // T942
    const sBRL24_b = (s as Record<string, unknown>)['blockRatioLast24h'] as number | null | undefined;
    if (sBRL24_b != null) console.log(`  Block ratio 24h:    ${(sBRL24_b * 100).toFixed(1)}%`); // T943
    const sBRL7d = (s as Record<string, unknown>)['blockRatioLast7d'] as number | null | undefined;
    if (sBRL7d != null) console.log(`  Block ratio 7d:     ${(sBRL7d * 100).toFixed(1)}%`); // T944
    const sBRL30d = (s as Record<string, unknown>)['blockRatioLast30d'] as number | null | undefined;
    if (sBRL30d != null) console.log(`  Block ratio 30d:    ${(sBRL30d * 100).toFixed(1)}%`); // T945
    const sAIM24 = (s as Record<string, unknown>)['avgIntervalMsLast24h'] as number | null | undefined;
    if (sAIM24 != null) console.log(`  Avg interval 24h:   ${Math.round(sAIM24 / 1000)}s`); // T946
    const sAIM7d = (s as Record<string, unknown>)['avgIntervalMsLast7d'] as number | null | undefined;
    if (sAIM7d != null) console.log(`  Avg interval 7d:    ${Math.round(sAIM7d / 1000)}s`); // T947
    const sPHOD_b = (s as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (sPHOD_b != null) console.log(`  Peak hour (UTC):    ${sPHOD_b}:00`); // T948
    const days7s = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const sPDOW = (s as Record<string, unknown>)['peakDayOfWeek'] as number | null | undefined;
    if (sPDOW != null) console.log(`  Peak day:           ${days7s[sPDOW]}`); // T949
    const sLADOW = (s as Record<string, unknown>)['leastActiveDayOfWeek'] as number | null | undefined;
    if (sLADOW != null) console.log(`  Least active day:   ${days7s[sLADOW]}`); // T950
    const sLAHOD = (s as Record<string, unknown>)['leastActiveHourOfDay'] as number | null | undefined;
    if (sLAHOD != null) console.log(`  Least active hour:  ${sLAHOD}:00`); // T951
    const sOL1_b = (s as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (sOL1_b != null) console.log(`  Ops last 1h:        ${sOL1_b}`); // T952
    const sBL1_b = (s as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (sBL1_b != null) console.log(`  Blocks last 1h:     ${sBL1_b}`); // T953
    const sAL1 = (s as Record<string, unknown>)['allowsLast1h'] as number | undefined;
    if (sAL1 != null) console.log(`  Allows last 1h:     ${sAL1}`); // T954
    const sARL1 = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (sARL1 != null) console.log(`  Avg risk 1h:        ${sARL1.toFixed(3)}`); // T955
    const sHRC1 = (s as Record<string, unknown>)['highRiskCountLast1h'] as number | undefined;
    if (sHRC1 != null) console.log(`  High risk last 1h:  ${sHRC1}`); // T956
    const sBR1 = (s as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (sBR1 != null) console.log(`  Block rate 1h:      ${(sBR1 * 100).toFixed(1)}%`); // T957
    const sAR1 = (s as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (sAR1 != null) console.log(`  Allow rate 1h:      ${(sAR1 * 100).toFixed(1)}%`); // T958
    const sAPR1 = (s as Record<string, unknown>)['approvalRateLast1h'] as number | null | undefined;
    if (sAPR1 != null) console.log(`  Approval rate 1h:   ${(sAPR1 * 100).toFixed(1)}%`); // T959
    const sRV1 = (s as Record<string, unknown>)['riskVolatilityLast1h'] as number | null | undefined;
    if (sRV1 != null) console.log(`  Risk volatility 1h: ${sRV1.toFixed(3)}`); // T960
    const sAPC1 = (s as Record<string, unknown>)['approvalCountLast1h'] as number | undefined;
    if (sAPC1 != null) console.log(`  Approvals last 1h:  ${sAPC1}`); // T961
    const sLRC1 = (s as Record<string, unknown>)['lowRiskCountLast1h'] as number | undefined;
    if (sLRC1 != null) console.log(`  Low risk last 1h:   ${sLRC1}`); // T962
    const sMRC1 = (s as Record<string, unknown>)['midRiskCountLast1h'] as number | undefined;
    if (sMRC1 != null) console.log(`  Mid risk last 1h:   ${sMRC1}`); // T963
    const sBRL1 = (s as Record<string, unknown>)['blockRatioLast1h'] as number | null | undefined;
    if (sBRL1 != null) console.log(`  Block ratio 1h:     ${(sBRL1 * 100).toFixed(1)}%`); // T964
    const sRWB24 = (s as Record<string, unknown>)['riskWeightedBlocksLast24h'] as number | null | undefined;
    if (sRWB24 != null) console.log(`  Risk-wtd blocks 24h:${sRWB24.toFixed(2)}`); // T965
    const sRWA24 = (s as Record<string, unknown>)['riskWeightedAllowsLast24h'] as number | null | undefined;
    if (sRWA24 != null) console.log(`  Risk-wtd allows 24h:${sRWA24.toFixed(2)}`); // T966
    const sRWB7 = (s as Record<string, unknown>)['riskWeightedBlocksLast7d'] as number | null | undefined;
    if (sRWB7 != null) console.log(`  Risk-wtd blocks 7d: ${sRWB7.toFixed(2)}`); // T967
    const sRWA7 = (s as Record<string, unknown>)['riskWeightedAllowsLast7d'] as number | null | undefined;
    if (sRWA7 != null) console.log(`  Risk-wtd allows 7d: ${sRWA7.toFixed(2)}`); // T968
    const sRWB30 = (s as Record<string, unknown>)['riskWeightedBlocksLast30d'] as number | null | undefined;
    if (sRWB30 != null) console.log(`  Risk-wtd blocks 30d:${sRWB30.toFixed(2)}`); // T969
    const sRWA30 = (s as Record<string, unknown>)['riskWeightedAllowsLast30d'] as number | null | undefined;
    if (sRWA30 != null) console.log(`  Risk-wtd allows 30d:${sRWA30.toFixed(2)}`); // T970
    const sNRW24 = (s as Record<string, unknown>)['netRiskWeightLast24h'] as number | undefined;
    if (sNRW24 != null) console.log(`  Net risk weight 24h:${sNRW24.toFixed(2)}`); // T971
    const sNRW7 = (s as Record<string, unknown>)['netRiskWeightLast7d'] as number | undefined;
    if (sNRW7 != null) console.log(`  Net risk weight 7d: ${sNRW7.toFixed(2)}`); // T972
    const sARWB24 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast24h'] as number | null | undefined;
    if (sARWB24 != null) console.log(`  Avg risk/block 24h: ${sARWB24.toFixed(3)}`); // T973
    const sARWA24 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast24h'] as number | null | undefined;
    if (sARWA24 != null) console.log(`  Avg risk/allow 24h: ${sARWA24.toFixed(3)}`); // T974
    const sARWB7 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast7d'] as number | null | undefined;
    if (sARWB7 != null) console.log(`  Avg risk/block 7d:  ${sARWB7.toFixed(3)}`); // T975
    const sARWA7 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast7d'] as number | null | undefined;
    if (sARWA7 != null) console.log(`  Avg risk/allow 7d:  ${sARWA7.toFixed(3)}`); // T976
    const sNRW30 = (s as Record<string, unknown>)['netRiskWeightLast30d'] as number | undefined;
    if (sNRW30 != null) console.log(`  Net risk weight 30d:${sNRW30.toFixed(2)}`); // T977
    const sARWB30 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast30d'] as number | null | undefined;
    if (sARWB30 != null) console.log(`  Avg risk/block 30d: ${sARWB30.toFixed(3)}`); // T978
    const sARWA30 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast30d'] as number | null | undefined;
    if (sARWA30 != null) console.log(`  Avg risk/allow 30d: ${sARWA30.toFixed(3)}`); // T979
    const sBAR24 = (s as Record<string, unknown>)['blockToAllowRatioLast24h'] as number | null | undefined;
    if (sBAR24 != null) console.log(`  Block:allow ratio 24h:${sBAR24.toFixed(2)}`); // T980
    const sBAR7 = (s as Record<string, unknown>)['blockToAllowRatioLast7d'] as number | null | undefined;
    if (sBAR7 != null) console.log(`  Block:allow ratio 7d: ${sBAR7.toFixed(2)}`); // T981
    const sBAR30 = (s as Record<string, unknown>)['blockToAllowRatioLast30d'] as number | null | undefined;
    if (sBAR30 != null) console.log(`  Block:allow ratio 30d:${sBAR30.toFixed(2)}`); // T982
    const sRSM24 = (s as Record<string, unknown>)['riskScoreMomentumLast24h'] as number | null | undefined;
    if (sRSM24 != null) console.log(`  Risk momentum 24h:  ${sRSM24 >= 0 ? '+' : ''}${sRSM24.toFixed(3)}`); // T983
    const sRSM7 = (s as Record<string, unknown>)['riskScoreMomentumLast7d'] as number | null | undefined;
    if (sRSM7 != null) console.log(`  Risk momentum 7d:   ${sRSM7 >= 0 ? '+' : ''}${sRSM7.toFixed(3)}`); // T984
    const sATBR24 = (s as Record<string, unknown>)['approvalToBlockRatioLast24h'] as number | null | undefined;
    if (sATBR24 != null) console.log(`  Approval:block 24h: ${sATBR24.toFixed(2)}`); // T985
    const sATBR7 = (s as Record<string, unknown>)['approvalToBlockRatioLast7d'] as number | null | undefined;
    if (sATBR7 != null) console.log(`  Approval:block 7d:  ${sATBR7.toFixed(2)}`); // T986
    const sOPH24 = (s as Record<string, unknown>)['opsPerHourLast24h'] as number | undefined;
    if (sOPH24 != null) console.log(`  Ops/hour last 24h:  ${sOPH24.toFixed(2)}`); // T987
    const sOPH7 = (s as Record<string, unknown>)['opsPerHourLast7d'] as number | undefined;
    if (sOPH7 != null) console.log(`  Ops/hour last 7d:   ${sOPH7.toFixed(2)}`); // T988
    const sOPH30 = (s as Record<string, unknown>)['opsPerHourLast30d'] as number | undefined;
    if (sOPH30 != null) console.log(`  Ops/hour last 30d:  ${sOPH30.toFixed(2)}`); // T989
    const sBPH24 = (s as Record<string, unknown>)['blocksPerHourLast24h'] as number | undefined;
    if (sBPH24 != null) console.log(`  Blocks/hr 24h:      ${sBPH24.toFixed(2)}`); // T990
    const sBPH7 = (s as Record<string, unknown>)['blocksPerHourLast7d'] as number | undefined;
    if (sBPH7 != null) console.log(`  Blocks/hr 7d:       ${sBPH7.toFixed(2)}`); // T991
    const sAPH24 = (s as Record<string, unknown>)['allowsPerHourLast24h'] as number | undefined;
    if (sAPH24 != null) console.log(`  Allows/hr 24h:      ${sAPH24.toFixed(2)}`); // T992
    const sAPH7 = (s as Record<string, unknown>)['allowsPerHourLast7d'] as number | undefined;
    if (sAPH7 != null) console.log(`  Allows/hr 7d:       ${sAPH7.toFixed(2)}`); // T993
    const sAPH30 = (s as Record<string, unknown>)['allowsPerHourLast30d'] as number | undefined;
    if (sAPH30 != null) console.log(`  Allows/hr 30d:      ${sAPH30.toFixed(2)}`); // T994
    const sBPH30 = (s as Record<string, unknown>)['blocksPerHourLast30d'] as number | undefined;
    if (sBPH30 != null) console.log(`  Blocks/hr 30d:      ${sBPH30.toFixed(2)}`); // T995
    const sHRPH24 = (s as Record<string, unknown>)['highRiskOpsPerHourLast24h'] as number | undefined;
    if (sHRPH24 != null) console.log(`  HiRisk ops/hr 24h:  ${sHRPH24.toFixed(2)}`); // T996
    const sHRPH7 = (s as Record<string, unknown>)['highRiskOpsPerHourLast7d'] as number | undefined;
    if (sHRPH7 != null) console.log(`  HiRisk ops/hr 7d:   ${sHRPH7.toFixed(2)}`); // T997
    const sUTC24 = (s as Record<string, unknown>)['uniqueToolsCountLast24h'] as number | undefined;
    if (sUTC24 != null) console.log(`  Unique tools 24h:   ${sUTC24}`); // T998
    const sUTC7 = (s as Record<string, unknown>)['uniqueToolsCountLast7d'] as number | undefined;
    if (sUTC7 != null) console.log(`  Unique tools 7d:    ${sUTC7}`); // T999
    const sUAC24 = (s as Record<string, unknown>)['uniqueAgentsCountLast24h'] as number | undefined;
    if (sUAC24 != null) console.log(`  Unique agents 24h:  ${sUAC24}`); // T1000
    const sUAC7 = (s as Record<string, unknown>)['uniqueAgentsCountLast7d'] as number | undefined;
    if (sUAC7 != null) console.log(`  Unique agents 7d:   ${sUAC7}`); // T1001
    const sMXR24 = (s as Record<string, unknown>)['maxRiskLast24h'] as number | null | undefined;
    if (sMXR24 != null) console.log(`  Max risk 24h:       ${sMXR24.toFixed(3)}`); // T1002
    const sMXR7 = (s as Record<string, unknown>)['maxRiskLast7d'] as number | null | undefined;
    if (sMXR7 != null) console.log(`  Max risk 7d:        ${sMXR7.toFixed(3)}`); // T1003
    const sMNR24 = (s as Record<string, unknown>)['minRiskLast24h'] as number | null | undefined;
    if (sMNR24 != null) console.log(`  Min risk 24h:       ${sMNR24.toFixed(3)}`); // T1004
    const sMNR7 = (s as Record<string, unknown>)['minRiskLast7d'] as number | null | undefined;
    if (sMNR7 != null) console.log(`  Min risk 7d:        ${sMNR7.toFixed(3)}`); // T1005
    const sMXR30 = (s as Record<string, unknown>)['maxRiskLast30d'] as number | null | undefined;
    if (sMXR30 != null) console.log(`  Max risk 30d:       ${sMXR30.toFixed(3)}`); // T1006
    const sMNR30 = (s as Record<string, unknown>)['minRiskLast30d'] as number | null | undefined;
    if (sMNR30 != null) console.log(`  Min risk 30d:       ${sMNR30.toFixed(3)}`); // T1007
    const sRRL24 = (s as Record<string, unknown>)['riskRangeLast24h'] as number | null | undefined;
    if (sRRL24 != null) console.log(`  Risk range 24h:     ${sRRL24.toFixed(3)}`); // T1008
    const sRRL7 = (s as Record<string, unknown>)['riskRangeLast7d'] as number | null | undefined;
    if (sRRL7 != null) console.log(`  Risk range 7d:      ${sRRL7.toFixed(3)}`); // T1009
    const sRRL30 = (s as Record<string, unknown>)['riskRangeLast30d'] as number | null | undefined;
    if (sRRL30 != null) console.log(`  Risk range 30d:     ${sRRL30.toFixed(3)}`); // T1010
    const sP25_b = (s as Record<string, unknown>)['p25Risk'] as number | null | undefined;
    if (sP25_b != null) console.log(`  P25 risk:           ${sP25_b.toFixed(3)}`); // T1011
    const sP75 = (s as Record<string, unknown>)['p75Risk'] as number | null | undefined;
    if (sP75 != null) console.log(`  P75 risk:           ${sP75.toFixed(3)}`); // T1012
    const sIQR_b = (s as Record<string, unknown>)['iqrRisk'] as number | null | undefined;
    if (sIQR_b != null) console.log(`  IQR risk:           ${sIQR_b.toFixed(3)}`); // T1013
    const sP95_b = (s as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (sP95_b != null) console.log(`  P95 risk:           ${sP95_b.toFixed(3)}`); // T1014
    const sP5 = (s as Record<string, unknown>)['p5Risk'] as number | null | undefined;
    if (sP5 != null) console.log(`  P5 risk:            ${sP5.toFixed(3)}`); // T1015
    const sRSS = (s as Record<string, unknown>)['riskSkewnessSign'] as number | null | undefined;
    if (sRSS != null) console.log(`  Risk skewness sign: ${sRSS}`); // T1016
    const sAPR30 = (s as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (sAPR30 != null) console.log(`  Approval rate 30d:  ${(sAPR30 * 100).toFixed(1)}%`); // T1017
    const sAPC30 = (s as Record<string, unknown>)['approvalCountLast30d'] as number | undefined;
    if (sAPC30 != null && sAPC30 > 0) console.log(`  Approvals 30d:      ${sAPC30}`); // T1018
    const sBC1h = (s as Record<string, unknown>)['blockCountLast1h'] as number | undefined;
    if (sBC1h != null && sBC1h > 0) console.log(`  Blocks last 1h:     ${sBC1h}`); // T1019
    const sAC1h = (s as Record<string, unknown>)['allowCountLast1h'] as number | undefined;
    if (sAC1h != null && sAC1h > 0) console.log(`  Allows last 1h:     ${sAC1h}`); // T1020
    const sAPC24_b = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (sAPC24_b != null && sAPC24_b > 0) console.log(`  Approvals 24h:      ${sAPC24_b}`); // T1021
    const sAPC7 = (s as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (sAPC7 != null && sAPC7 > 0) console.log(`  Approvals 7d:       ${sAPC7}`); // T1022
    const sAPR24_b = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (sAPR24_b != null) console.log(`  Approval rate 24h:  ${(sAPR24_b * 100).toFixed(1)}%`); // T1023
    const sAPR7 = (s as Record<string, unknown>)['approvalRateLast7d'] as number | null | undefined;
    if (sAPR7 != null) console.log(`  Approval rate 7d:   ${(sAPR7 * 100).toFixed(1)}%`); // T1024
    const sBR1h = (s as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (sBR1h != null) console.log(`  Block rate 1h:      ${(sBR1h * 100).toFixed(1)}%`); // T1025
    const sAR1h = (s as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (sAR1h != null) console.log(`  Allow rate 1h:      ${(sAR1h * 100).toFixed(1)}%`); // T1026
    const sBR7 = (s as Record<string, unknown>)['blockRateLast7d'] as number | null | undefined;
    if (sBR7 != null) console.log(`  Block rate 7d:      ${(sBR7 * 100).toFixed(1)}%`); // T1027
    const sAR7 = (s as Record<string, unknown>)['allowRateLast7d'] as number | null | undefined;
    if (sAR7 != null) console.log(`  Allow rate 7d:      ${(sAR7 * 100).toFixed(1)}%`); // T1028
    const sBR30 = (s as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (sBR30 != null) console.log(`  Block rate 30d:     ${(sBR30 * 100).toFixed(1)}%`); // T1029
    const sAR30 = (s as Record<string, unknown>)['allowRateLast30d'] as number | null | undefined;
    if (sAR30 != null) console.log(`  Allow rate 30d:     ${(sAR30 * 100).toFixed(1)}%`); // T1030
    const sOC1h = (s as Record<string, unknown>)['opCountLast1h'] as number | undefined;
    if (sOC1h != null && sOC1h > 0) console.log(`  Ops last 1h:        ${sOC1h}`); // T1031
    const sOC24 = (s as Record<string, unknown>)['opCountLast24h'] as number | undefined;
    if (sOC24 != null && sOC24 > 0) console.log(`  Ops last 24h:       ${sOC24}`); // T1032
    const sOC7 = (s as Record<string, unknown>)['opCountLast7d'] as number | undefined;
    if (sOC7 != null && sOC7 > 0) console.log(`  Ops last 7d:        ${sOC7}`); // T1033
    const sOC30 = (s as Record<string, unknown>)['opCountLast30d'] as number | undefined;
    if (sOC30 != null && sOC30 > 0) console.log(`  Ops last 30d:       ${sOC30}`); // T1034
    const sBC24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (sBC24 != null && sBC24 > 0) console.log(`  Blocks 24h:         ${sBC24}`); // T1035
    const sBC7 = (s as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (sBC7 != null && sBC7 > 0) console.log(`  Blocks 7d:          ${sBC7}`); // T1036
    const sBC30 = (s as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (sBC30 != null && sBC30 > 0) console.log(`  Blocks 30d:         ${sBC30}`); // T1037
    const sAC24 = (s as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (sAC24 != null && sAC24 > 0) console.log(`  Allows 24h:         ${sAC24}`); // T1038
    const sAC7 = (s as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (sAC7 != null && sAC7 > 0) console.log(`  Allows 7d:          ${sAC7}`); // T1039
    const sAC30 = (s as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (sAC30 != null && sAC30 > 0) console.log(`  Allows 30d:         ${sAC30}`); // T1040
    const sHRC24_b = (s as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (sHRC24_b != null && sHRC24_b > 0) console.log(`  High-risk 24h:      ${sHRC24_b}`); // T1041
    const sHRC7 = (s as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (sHRC7 != null && sHRC7 > 0) console.log(`  High-risk 7d:       ${sHRC7}`); // T1042
    const sHRC30 = (s as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (sHRC30 != null && sHRC30 > 0) console.log(`  High-risk 30d:      ${sHRC30}`); // T1043
    const sHRR24 = (s as Record<string, unknown>)['highRiskRateLast24h'] as number | null | undefined;
    if (sHRR24 != null) console.log(`  High-risk rate 24h: ${(sHRR24 * 100).toFixed(1)}%`); // T1044
    const sHRR7 = (s as Record<string, unknown>)['highRiskRateLast7d'] as number | null | undefined;
    if (sHRR7 != null) console.log(`  High-risk rate 7d:  ${(sHRR7 * 100).toFixed(1)}%`); // T1045
    const sHRR30 = (s as Record<string, unknown>)['highRiskRateLast30d'] as number | null | undefined;
    if (sHRR30 != null) console.log(`  High-risk rate 30d: ${(sHRR30 * 100).toFixed(1)}%`); // T1046
    const sLRC24_b = (s as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (sLRC24_b != null && sLRC24_b > 0) console.log(`  Low-risk 24h:       ${sLRC24_b}`); // T1047
    const sLRC7 = (s as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (sLRC7 != null && sLRC7 > 0) console.log(`  Low-risk 7d:        ${sLRC7}`); // T1048
    const sLRC30 = (s as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (sLRC30 != null && sLRC30 > 0) console.log(`  Low-risk 30d:       ${sLRC30}`); // T1049
    const sLRR24 = (s as Record<string, unknown>)['lowRiskRateLast24h'] as number | null | undefined;
    if (sLRR24 != null) console.log(`  Low-risk rate 24h:  ${(sLRR24 * 100).toFixed(1)}%`); // T1050
    const sLRR7 = (s as Record<string, unknown>)['lowRiskRateLast7d'] as number | null | undefined;
    if (sLRR7 != null) console.log(`  Low-risk rate 7d:   ${(sLRR7 * 100).toFixed(1)}%`); // T1051
    const sLRR30 = (s as Record<string, unknown>)['lowRiskRateLast30d'] as number | null | undefined;
    if (sLRR30 != null) console.log(`  Low-risk rate 30d:  ${(sLRR30 * 100).toFixed(1)}%`); // T1052
    const sMRC24_b = (s as Record<string, unknown>)['medRiskCountLast24h'] as number | undefined;
    if (sMRC24_b != null && sMRC24_b > 0) console.log(`  Med-risk 24h:       ${sMRC24_b}`); // T1053
    const sMRC7 = (s as Record<string, unknown>)['medRiskCountLast7d'] as number | undefined;
    if (sMRC7 != null && sMRC7 > 0) console.log(`  Med-risk 7d:        ${sMRC7}`); // T1054
    const sMRC30 = (s as Record<string, unknown>)['medRiskCountLast30d'] as number | undefined;
    if (sMRC30 != null && sMRC30 > 0) console.log(`  Med-risk 30d:       ${sMRC30}`); // T1055
    const sMRR24 = (s as Record<string, unknown>)['medRiskRateLast24h'] as number | null | undefined;
    if (sMRR24 != null) console.log(`  Med-risk rate 24h:  ${(sMRR24 * 100).toFixed(1)}%`); // T1056
    const sMRR7 = (s as Record<string, unknown>)['medRiskRateLast7d'] as number | null | undefined;
    if (sMRR7 != null) console.log(`  Med-risk rate 7d:   ${(sMRR7 * 100).toFixed(1)}%`); // T1057
    const sMRR30 = (s as Record<string, unknown>)['medRiskRateLast30d'] as number | null | undefined;
    if (sMRR30 != null) console.log(`  Med-risk rate 30d:  ${(sMRR30 * 100).toFixed(1)}%`); // T1058
    const sRV24_b = (s as Record<string, unknown>)['riskVarianceLast24h'] as number | null | undefined;
    if (sRV24_b != null) console.log(`  Risk variance 24h:  ${sRV24_b.toFixed(4)}`); // T1059
    const sRV7 = (s as Record<string, unknown>)['riskVarianceLast7d'] as number | null | undefined;
    if (sRV7 != null) console.log(`  Risk variance 7d:   ${sRV7.toFixed(4)}`); // T1060
    const sRSD24 = (s as Record<string, unknown>)['riskStdDevLast24h'] as number | null | undefined;
    if (sRSD24 != null) console.log(`  Risk std dev 24h:   ${sRSD24.toFixed(3)}`); // T1061
    const sRSD7 = (s as Record<string, unknown>)['riskStdDevLast7d'] as number | null | undefined;
    if (sRSD7 != null) console.log(`  Risk std dev 7d:    ${sRSD7.toFixed(3)}`); // T1062
    const sRSD30 = (s as Record<string, unknown>)['riskStdDevLast30d'] as number | null | undefined;
    if (sRSD30 != null) console.log(`  Risk std dev 30d:   ${sRSD30.toFixed(3)}`); // T1063
    const sRVA30 = (s as Record<string, unknown>)['riskVarianceLast30d'] as number | null | undefined;
    if (sRVA30 != null) console.log(`  Risk variance 30d:  ${sRVA30.toFixed(4)}`); // T1064
    const sAR1h_b = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (sAR1h_b != null) console.log(`  Avg risk 1h:        ${sAR1h_b.toFixed(3)}`); // T1065
    const sAR24 = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (sAR24 != null) console.log(`  Avg risk 24h:       ${sAR24.toFixed(3)}`); // T1066
    const sAR7_b = (s as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (sAR7_b != null) console.log(`  Avg risk 7d:        ${sAR7_b.toFixed(3)}`); // T1067
    const sAR30_b = (s as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (sAR30_b != null) console.log(`  Avg risk 30d:       ${sAR30_b.toFixed(3)}`); // T1068
    const sART1h = (s as Record<string, unknown>)['avgRiskTrend1hVs24h'] as number | null | undefined;
    if (sART1h != null) console.log(`  Avg risk trend 1h>24h: ${sART1h.toFixed(3)}`); // T1069
    const sART24 = (s as Record<string, unknown>)['avgRiskTrend24hVs7d'] as number | null | undefined;
    if (sART24 != null) console.log(`  Avg risk trend 24h>7d: ${sART24.toFixed(3)}`); // T1070
    const sART7 = (s as Record<string, unknown>)['avgRiskTrend7dVs30d'] as number | null | undefined;
    if (sART7 != null) console.log(`  Avg risk trend 7d>30d: ${sART7.toFixed(3)}`); // T1071
    const sMXR_b = (s as Record<string, unknown>)['maxRiskAllTime'] as number | null | undefined;
    if (sMXR_b != null) console.log(`  Max risk all-time:     ${sMXR_b.toFixed(3)}`); // T1072
    const sMNR_b = (s as Record<string, unknown>)['minRiskAllTime'] as number | null | undefined;
    if (sMNR_b != null) console.log(`  Min risk all-time:     ${sMNR_b.toFixed(3)}`); // T1073
    const sOCT1 = (s as Record<string, unknown>)['opCountTrend1hVs24h'] as number | null | undefined;
    if (sOCT1 != null) console.log(`  Op count trend 1h>24h: ${sOCT1.toFixed(2)}`); // T1074
    const sOCT24 = (s as Record<string, unknown>)['opCountTrend24hVs7d'] as number | null | undefined;
    if (sOCT24 != null) console.log(`  Op count trend 24h>7d: ${sOCT24.toFixed(2)}`); // T1075
    const sBCT_b = (s as Record<string, unknown>)['blockCountTrend1hVs24h'] as number | null | undefined;
    if (sBCT_b != null) console.log(`  Block count trend 1h>24h: ${sBCT_b.toFixed(2)}`); // T1076
    const sACT_b = (s as Record<string, unknown>)['allowCountTrend1hVs24h'] as number | null | undefined;
    if (sACT_b != null) console.log(`  Allow count trend 1h>24h: ${sACT_b.toFixed(2)}`); // T1077
    const sAPCT = (s as Record<string, unknown>)['approvalCountTrend1hVs24h'] as number | null | undefined;
    if (sAPCT != null) console.log(`  Approval count trend 1h>24h: ${sAPCT.toFixed(2)}`); // T1078
    const sBCT24 = (s as Record<string, unknown>)['blockCountTrend24hVs7d'] as number | null | undefined;
    if (sBCT24 != null) console.log(`  Block count trend 24h>7d:  ${sBCT24.toFixed(2)}`); // T1079
    const sACT24 = (s as Record<string, unknown>)['allowCountTrend24hVs7d'] as number | null | undefined;
    if (sACT24 != null) console.log(`  Allow count trend 24h>7d:  ${sACT24.toFixed(2)}`); // T1080
    const sAPCT24 = (s as Record<string, unknown>)['approvalCountTrend24hVs7d'] as number | null | undefined;
    if (sAPCT24 != null) console.log(`  Approval count trend 24h>7d: ${sAPCT24.toFixed(2)}`); // T1081
    const sBCT7 = (s as Record<string, unknown>)['blockCountTrend7dVs30d'] as number | null | undefined;
    if (sBCT7 != null) console.log(`  Block count trend 7d>30d:  ${sBCT7.toFixed(2)}`); // T1082
    const sACT7 = (s as Record<string, unknown>)['allowCountTrend7dVs30d'] as number | null | undefined;
    if (sACT7 != null) console.log(`  Allow count trend 7d>30d:  ${sACT7.toFixed(2)}`); // T1083
    const sAPCT7 = (s as Record<string, unknown>)['approvalCountTrend7dVs30d'] as number | null | undefined;
    if (sAPCT7 != null) console.log(`  Approval count trend 7d>30d: ${sAPCT7.toFixed(2)}`); // T1084
    const sRRA = (s as Record<string, unknown>)['riskRangeAllTime'] as number | null | undefined;
    if (sRRA != null) console.log(`  Risk range all-time:   ${sRRA.toFixed(3)}`); // T1085
    const sRP25 = (s as Record<string, unknown>)['riskP25'] as number | null | undefined;
    if (sRP25 != null) console.log(`  Risk P25:              ${sRP25.toFixed(3)}`); // T1086
    const sRP75 = (s as Record<string, unknown>)['riskP75'] as number | null | undefined;
    if (sRP75 != null) console.log(`  Risk P75:              ${sRP75.toFixed(3)}`); // T1087
    const sRIQR_c = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (sRIQR_c != null) console.log(`  Risk IQR:              ${sRIQR_c.toFixed(3)}`); // T1088
    const sRP25h24 = (s as Record<string, unknown>)['riskP25Last24h'] as number | null | undefined;
    if (sRP25h24 != null) console.log(`  Risk P25 24h:          ${sRP25h24.toFixed(3)}`); // T1089
    const sRP75h24 = (s as Record<string, unknown>)['riskP75Last24h'] as number | null | undefined;
    if (sRP75h24 != null) console.log(`  Risk P75 24h:          ${sRP75h24.toFixed(3)}`); // T1090
    const sRIQRh24 = (s as Record<string, unknown>)['riskIQRLast24h'] as number | null | undefined;
    if (sRIQRh24 != null) console.log(`  Risk IQR 24h:          ${sRIQRh24.toFixed(3)}`); // T1091
    const sRP25d7 = (s as Record<string, unknown>)['riskP25Last7d'] as number | null | undefined;
    if (sRP25d7 != null) console.log(`  Risk P25 7d:           ${sRP25d7.toFixed(3)}`); // T1092
    const sRP75d7 = (s as Record<string, unknown>)['riskP75Last7d'] as number | null | undefined;
    if (sRP75d7 != null) console.log(`  Risk P75 7d:           ${sRP75d7.toFixed(3)}`); // T1093
    const sRIQRd7 = (s as Record<string, unknown>)['riskIQRLast7d'] as number | null | undefined;
    if (sRIQRd7 != null) console.log(`  Risk IQR 7d:           ${sRIQRd7.toFixed(3)}`); // T1094
    const sRP25d30 = (s as Record<string, unknown>)['riskP25Last30d'] as number | null | undefined;
    if (sRP25d30 != null) console.log(`  Risk P25 30d:          ${sRP25d30.toFixed(3)}`); // T1095
    const sRP75d30 = (s as Record<string, unknown>)['riskP75Last30d'] as number | null | undefined;
    if (sRP75d30 != null) console.log(`  Risk P75 30d:          ${sRP75d30.toFixed(3)}`); // T1096
    const sRIQRd30 = (s as Record<string, unknown>)['riskIQRLast30d'] as number | null | undefined;
    if (sRIQRd30 != null) console.log(`  Risk IQR 30d:          ${sRIQRd30.toFixed(3)}`); // T1097
    const sRP10 = (s as Record<string, unknown>)['riskP10'] as number | null | undefined;
    if (sRP10 != null) console.log(`  Risk P10:              ${sRP10.toFixed(3)}`); // T1098
    const sDOW = (s as Record<string, unknown>)['avgRiskByDayOfWeek'] as Array<number | null> | undefined;
    if (sDOW && sDOW.some(v => v !== null)) { // T652
      const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      const dowStr = sDOW.map((v, i) => `${days[i]}:${v !== null ? (v*100).toFixed(0)+'%' : '--'}`).join(' ');
      console.log(`  Risk by day:  ${dowStr}`);
    }
    const sCBD = (s as Record<string, unknown>)['operationsCountByDay'] as number[] | undefined;
    if (sCBD && sCBD.some(v => v > 0)) { // T653
      const max = Math.max(...sCBD, 1);
      const spark = sCBD.map(v => v === 0 ? '·' : v / max >= 0.7 ? '█' : v / max >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Ops/day sparkline: ${spark} (today←6d ago)`);
    }
    const sessTopRiskAgents = (s as Record<string, unknown>)['topRiskAgents'] as Array<{agentId: string; avgRisk: number}> | undefined;
    if (sessTopRiskAgents && sessTopRiskAgents.length > 1) { // T586: only show if multi-agent session
      console.log(`  Top risk agents: ${sessTopRiskAgents.map(a => `${a.agentId.slice(0,12)}(${(a.avgRisk*100).toFixed(0)}%)`).join(', ')}`);
    }
    if (s.recentBlockedOps && s.recentBlockedOps.length > 0) { // T446
      console.log(`  Recent blocks (${s.recentBlockedOps.length}):`);
      for (const op of s.recentBlockedOps) {
        console.log(`    ${op['tool']}.${op['method']} risk=${((op['riskScore'] as number) * 100).toFixed(0)}%`);
      }
    }
    console.log(`\n  Recent ops (${s.recentOps.length}):`);
    for (const op of s.recentOps.slice(0, 5)) {
      console.log(`    ${op['action']} ${op['tool']}.${op['method']} risk=${((op['riskScore'] as number) * 100).toFixed(0)}%`);
    }
  } else {
    // T294: --agent filter; T335: --limit/--offset/--sort/--order; T343: --min-ops/--max-ops; T388: --min-avg-risk/--max-avg-risk
    const agentFilter    = parseFlag(args, 'agent');
    const sessLimit      = parseFlag(args, 'limit');
    const sessOffset     = parseFlag(args, 'offset');
    const sessSort       = parseFlag(args, 'sort');
    const sessOrder      = parseFlag(args, 'order');
    const sessMinOps     = parseFlag(args, 'min-ops');
    const sessMaxOps     = parseFlag(args, 'max-ops');
    const sessMinAvgRisk    = parseFlag(args, 'min-avg-risk');
    const sessMaxAvgRisk    = parseFlag(args, 'max-avg-risk');
    const sessMinBlockRate  = parseFlag(args, 'min-block-rate'); // T393
    const sessMaxBlockRate  = parseFlag(args, 'max-block-rate'); // T393
    const params = new URLSearchParams();
    if (agentFilter)       params.set('agentId', agentFilter);
    if (sessLimit)         params.set('limit', sessLimit);
    if (sessOffset)        params.set('offset', sessOffset);
    if (sessSort)          params.set('sort', sessSort);
    if (sessOrder)         params.set('order', sessOrder);
    if (sessMinOps)        params.set('minOps', sessMinOps);
    if (sessMaxOps)        params.set('maxOps', sessMaxOps);
    if (sessMinAvgRisk)    params.set('minAvgRisk', sessMinAvgRisk);
    if (sessMaxAvgRisk)    params.set('maxAvgRisk', sessMaxAvgRisk);
    if (sessMinBlockRate)  params.set('minBlockRate', sessMinBlockRate);
    if (sessMaxBlockRate)  params.set('maxBlockRate', sessMaxBlockRate);
    const url = `/sessions${params.toString() ? `?${params}` : ''}`;
    const { status, body } = await dashFetch(state.dashboardPort, 'GET', url);
    if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
    const r = body as { data: Array<{ sessionId: string; agentId: string; operationCount: number; blocked: number; lastSeen: string }>; count: number; totalBlocked?: number; totalAllowed?: number; avgBlockRate?: number };
    if (r.count === 0) { console.log('No sessions found.'); return; }
    // T448: show aggregates if present
    if (r.totalBlocked !== undefined || r.totalAllowed !== undefined || r.avgBlockRate !== undefined) {
      const parts: string[] = [];
      if (r.totalBlocked !== undefined)  parts.push(`totalBlocked=${r.totalBlocked}`);
      if (r.totalAllowed !== undefined)  parts.push(`totalAllowed=${r.totalAllowed}`);
      if (r.avgBlockRate !== undefined)  parts.push(`avgBlockRate=${(r.avgBlockRate * 100).toFixed(1)}%`);
      console.log(`Aggregates: ${parts.join('  ')}`);
    }
    console.log(`\nSessions (${r.count}):\n`);
    console.log('  SESSION'.padEnd(40) + 'AGENT'.padEnd(24) + 'OPS'.padEnd(6) + 'BLOCKED');
    console.log('  ' + '─'.repeat(74));
    for (const s of r.data) {
      console.log(`  ${s.sessionId.slice(0, 38).padEnd(40)}${s.agentId.slice(0, 22).padEnd(24)}${String(s.operationCount).padEnd(6)}${s.blocked}`);
    }
  }
}
