import { parseFlag, readState, dashFetch } from './shared.js';

export async function cmdAgents(args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const agentId = args.find(a => !a.startsWith('--'));
  if (agentId) {
    const subCmd = args[1];
    // T286: agentsgate agent <id> tools — show per-tool breakdown; T403: --sort/--order flags
    if (subCmd === 'tools') {
      const agentToolsSort  = parseFlag(args, 'sort');
      const agentToolsOrder = parseFlag(args, 'order');
      const agentToolsParams = new URLSearchParams();
      if (agentToolsSort)  agentToolsParams.set('sort', agentToolsSort);
      if (agentToolsOrder) agentToolsParams.set('order', agentToolsOrder);
      const agentToolsQS = agentToolsParams.toString() ? `?${agentToolsParams}` : '';
      const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/agents/${encodeURIComponent(agentId)}/tools${agentToolsQS}`);
      if (status === 404) { console.error(`Agent not found: ${agentId}`); process.exit(1); }
      const b = body as { agentId: string; tools: Array<{ tool: string; totalOps: number; blockRate: number; avgRisk: number }>; count: number };
      if (b.count === 0) { console.log(`No tool data for agent ${agentId}.`); return; }
      console.log(`Agent ${b.agentId} — per-tool breakdown (${b.count}):\n`);
      console.log('TOOL'.padEnd(28) + 'OPS'.padEnd(8) + 'BLOCK RATE   AVG RISK');
      console.log('─'.repeat(72));
      for (const t of b.tools) {
        console.log(`${t.tool.slice(0,26).padEnd(28)}${String(t.totalOps).padEnd(8)}${(t.blockRate * 100).toFixed(1).padEnd(13)}${(t.avgRisk * 100).toFixed(1)}%`);
      }
      return;
    }

    // T297: agentsgate agent <id> risk — risk profile via GET /agents/:agentId/risk
    if (subCmd === 'risk') {
      const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/agents/${encodeURIComponent(agentId)}/risk`);
      if (status === 404) { console.error(`No operations found for agent: ${agentId}`); process.exit(1); }
      const r = body as { agentId: string; totalOps: number; avgRisk: number; maxRisk: number; riskBuckets: Record<string, number> };
      console.log(`Agent Risk Profile: ${r.agentId}`);
      console.log(`  Total ops: ${r.totalOps}`);
      console.log(`  Avg risk:  ${(r.avgRisk * 100).toFixed(1)}%`);
      console.log(`  Max risk:  ${(r.maxRisk * 100).toFixed(1)}%`);
      console.log(`\n  Risk distribution:`);
      for (const [bucket, count] of Object.entries(r.riskBuckets)) {
        const bar = '█'.repeat(Math.round((count / r.totalOps) * 20));
        console.log(`    ${bucket}: ${String(count).padStart(4)}  ${bar}`);
      }
      return;
    }

    const { status, body } = await dashFetch(state.dashboardPort, 'GET', `/agents/${encodeURIComponent(agentId)}`);
    if (status === 404) { console.error(`Agent not found: ${agentId}`); process.exit(1); }
    const a = body as { agentId: string; totalOps: number; byAction: { allow: number; block: number; require_approval: number }; avgRiskScore: number; maxRiskScore: number; minRiskScore?: number; medianRiskScore?: number; highRiskCount?: number; mediumRiskCount?: number; lowRiskCount?: number; riskBuckets?: Record<string, number>; lastSeen: string; blockStreak?: number; allowStreak?: number; pendingCount?: number; topTools: Array<{ tool: string; count: number }>; topSessions?: Array<{ sessionId: string; count: number }> };
    console.log(`Agent: ${a.agentId}`);
    console.log(`  Total ops:  ${a.totalOps}  (allow ${a.byAction.allow} / block ${a.byAction.block} / approval ${a.byAction.require_approval})`);
    console.log(`  Avg risk:   ${(a.avgRiskScore * 100).toFixed(1)}%  max ${(a.maxRiskScore * 100).toFixed(1)}%`);
    if (a.medianRiskScore !== undefined) console.log(`  Median risk: ${(a.medianRiskScore * 100).toFixed(1)}%`); // T444
    if (a.highRiskCount !== undefined) console.log(`  High risk (≥70%):  ${a.highRiskCount}`); // T474
    if (a.mediumRiskCount !== undefined) console.log(`  Med risk (30-70%): ${a.mediumRiskCount}`); // T474
    if (a.lowRiskCount !== undefined) console.log(`  Low risk (<30%):   ${a.lowRiskCount}`); // T474
    if (a.pendingCount !== undefined && a.pendingCount > 0) console.log(`  Pending:    ${a.pendingCount}`); // T444
    if (a.blockStreak !== undefined && a.blockStreak > 0) console.log(`  Block streak: ${a.blockStreak} consecutive`); // T444
    if (a.allowStreak !== undefined && a.allowStreak > 0) console.log(`  Allow streak: ${a.allowStreak} consecutive`); // T444
    console.log(`  Last seen:  ${a.lastSeen}`);
    if (a.topTools.length) {
      console.log(`  Top tools:  ${a.topTools.map(t => `${t.tool}(${t.count})`).join(', ')}`);
    }
    if (a.topSessions && a.topSessions.length) { // T444
      console.log(`  Top sessions: ${a.topSessions.map(s => `${s.sessionId}(${s.count})`).join(', ')}`);
    }
    if (a.riskBuckets) { // T495: risk bucket distribution
      const bkts = Object.entries(a.riskBuckets).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`  Risk buckets: ${bkts}`);
    }
    const topSessByRisk = (a as Record<string, unknown>)['topSessionsByRisk'] as Array<{sessionId: string; avgRisk: number}> | undefined;
    if (topSessByRisk && topSessByRisk.length) { // T534
      console.log(`  Top risk sessions: ${topSessByRisk.map(s => `${s.sessionId.slice(0,12)}(${(s.avgRisk*100).toFixed(0)}%)`).join(', ')}`);
    }
    const topToolsByRisk = (a as Record<string, unknown>)['topToolsByRisk'] as Array<{tool: string; avgRisk: number}> | undefined;
    if (topToolsByRisk && topToolsByRisk.length) { // T534
      console.log(`  Top risk tools: ${topToolsByRisk.map(t => `${t.tool}(${(t.avgRisk*100).toFixed(0)}%)`).join(', ')}`);
    }
    const aR1h = (a as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (aR1h !== undefined && aR1h !== null) console.log(`  Avg risk (1h):  ${(aR1h * 100).toFixed(1)}%`); // T561
    const aR24h = (a as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (aR24h !== undefined && aR24h !== null) console.log(`  Avg risk (24h): ${(aR24h * 100).toFixed(1)}%`); // T561
    const aBk24 = (a as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    const aBk1  = (a as Record<string, unknown>)['blockCountLast1h']  as number | undefined;
    if (aBk24 !== undefined) console.log(`  Blocks (24h):   ${aBk24}  (1h: ${aBk1 ?? 0})`); // T570
    const aAR = (a as Record<string, unknown>)['avgAllowRisk'] as number | null | undefined;
    const aBR = (a as Record<string, unknown>)['avgBlockRisk'] as number | null | undefined;
    if (aAR !== undefined && aAR !== null) console.log(`  Avg risk allow: ${(aAR * 100).toFixed(1)}%  block: ${aBR !== undefined && aBR !== null ? (aBR * 100).toFixed(1) + '%' : '—'}`); // T580
    const aPR = (a as Record<string, unknown>)['avgPendingRisk'] as number | null | undefined;
    if (aPR !== undefined && aPR !== null) console.log(`  Avg risk pending: ${(aPR * 100).toFixed(1)}%`); // T591
    const aSD = (a as Record<string, unknown>)['riskScoreStdDev'] as number | undefined;
    if (aSD !== undefined && aSD > 0) console.log(`  Risk std dev:    ${(aSD * 100).toFixed(1)}%`); // T592
    const aOR = (a as Record<string, unknown>)['operationRate'] as number | undefined;
    if (aOR !== undefined) console.log(`  Op rate (24h):   ${aOR.toFixed(3)} ops/min`); // T597
    const aP25 = (a as Record<string, unknown>)['p25RiskScore'] as number | undefined;
    const aIQR = (a as Record<string, unknown>)['interquartileRange'] as number | undefined;
    if (aP25 !== undefined) console.log(`  p25 risk:        ${(aP25 * 100).toFixed(1)}%${aIQR !== undefined ? `  IQR: ${(aIQR * 100).toFixed(1)}%` : ''}`); // T606
    const aSkew = (a as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (aSkew !== undefined && aSkew !== null) console.log(`  Risk skewness:   ${aSkew.toFixed(3)}`); // T612
    const aConc = (a as Record<string, unknown>)['riskConcentration'] as number | null | undefined;
    if (aConc !== undefined && aConc !== null) console.log(`  Risk concentration: ${(aConc * 100).toFixed(1)}% (top 20% ops)`); // T615
    const aHRR = (a as Record<string, unknown>)['highRiskRate'] as number | undefined;
    const aMRR = (a as Record<string, unknown>)['mediumRiskRate'] as number | undefined;
    const aLRR = (a as Record<string, unknown>)['lowRiskRate'] as number | undefined;
    if (aHRR !== undefined) console.log(`  Risk tiers:      H:${(aHRR*100).toFixed(1)}%${aMRR!==undefined?` M:${(aMRR*100).toFixed(1)}%`:''}${aLRR!==undefined?` L:${(aLRR*100).toFixed(1)}%`:''}`); // T636-T639
    const aRV = (a as Record<string, unknown>)['riskVelocity'] as number | null | undefined;
    if (aRV !== undefined && aRV !== null) console.log(`  Risk velocity:   ${aRV >= 0 ? '+' : ''}${(aRV * 100).toFixed(2)}% (1h delta)`); // T618
    const aBV = (a as Record<string, unknown>)['blockVelocity'] as number | null | undefined;
    if (aBV !== undefined && aBV !== null) console.log(`  Block velocity:  ${aBV >= 0 ? '+' : ''}${aBV} (1h delta)`); // T619
    const aTRO = (a as Record<string, unknown>)['topRiskOps'] as Array<Record<string, unknown>> | undefined;
    if (aTRO && aTRO.length > 0) { // T620
      console.log(`  Top risk ops:    ${aTRO.slice(0, 3).map(o => `${o['tool']}:${(( o['riskScore'] as number)*100).toFixed(0)}%`).join(', ')}`);
    }
    const aTMBC = (a as Record<string, unknown>)['topMethodsByBlockCount'] as Array<{method: string; blocked: number}> | undefined;
    if (aTMBC && aTMBC.length > 0) console.log(`  Top blocked methods: ${aTMBC.slice(0,3).map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T641
    const aHourly = (a as Record<string, unknown>)['avgRiskByHour'] as Array<number | null> | undefined;
    if (aHourly && aHourly.some(v => v !== null)) { // T623
      const spark = aHourly.slice(0, 12).map(v => v === null ? '·' : v >= 0.7 ? '█' : v >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Risk/hr sparkline: ${spark} (last 12h, newest left)`);
    }
    const aCBRA = (a as Record<string, unknown>)['consecutiveBlockRatio'] as number | undefined;
    if (aCBRA !== undefined && aCBRA > 0) console.log(`  Consec block ratio: ${(aCBRA * 100).toFixed(1)}%`); // T659
    const aRA = (a as Record<string, unknown>)['riskAcceleration'] as number | null | undefined;
    if (aRA !== null && aRA !== undefined) console.log(`  Risk acceleration:  ${aRA >= 0 ? '+' : ''}${(aRA * 100).toFixed(1)}%`); // T660
    const aTSR = (a as Record<string, unknown>)['toolSwitchRate'] as number | null | undefined;
    if (aTSR !== null && aTSR !== undefined) console.log(`  Tool switch rate:   ${(aTSR * 100).toFixed(1)}%`); // T661
    const aMSR = (a as Record<string, unknown>)['methodSwitchRate'] as number | null | undefined;
    if (aMSR !== null && aMSR !== undefined) console.log(`  Method switch rate: ${(aMSR * 100).toFixed(1)}%`); // T663
    const aPOPM = (a as Record<string, unknown>)['peakOpsPerMinute'] as number | undefined;
    if (aPOPM !== undefined && aPOPM > 0) console.log(`  Peak ops/min:       ${aPOPM.toFixed(2)}`); // T662
    const aRASc = (a as Record<string, unknown>)['riskAnomalyScore'] as number | null | undefined;
    if (aRASc !== null && aRASc !== undefined) console.log(`  Risk anomaly (z):   ${aRASc >= 0 ? '+' : ''}${aRASc.toFixed(2)}`); // T664
    const aBRL = (a as Record<string, unknown>)['blockRunLengths'] as Record<string, number> | undefined;
    if (aBRL && Object.values(aBRL).some(v => v > 0)) { const parts = Object.entries(aBRL).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Block run lengths:  ${parts}`); } // T665
    const aATBO = (a as Record<string, unknown>)['avgTimeBetweenOps'] as number | null | undefined;
    if (aATBO !== null && aATBO !== undefined) console.log(`  Avg time bet. ops:  ${(aATBO / 1000).toFixed(1)}s`); // T666
    const aIR = (a as Record<string, unknown>)['idleRatio'] as number | undefined;
    if (aIR !== undefined) console.log(`  Idle ratio (24h):   ${(aIR * 100).toFixed(0)}%`); // T668
    const aRP = (a as Record<string, unknown>)['riskProfile'] as string | undefined;
    if (aRP) console.log(`  Risk profile:       ${aRP.toUpperCase()}`); // T669
    const aBBS = (a as Record<string, unknown>)['blockBurstScore'] as number | undefined;
    if (aBBS !== undefined && aBBS > 0) console.log(`  Block burst score:  ${(aBBS * 100).toFixed(1)}%`); // T670
    const aPSA = (a as Record<string, unknown>)['pendingStreak'] as number | undefined;
    if (aPSA !== undefined && aPSA > 0) console.log(`  Pending streak:     ${aPSA}`); // T671
    const aRSC = (a as Record<string, unknown>)['riskSkewnessCategory'] as string | null | undefined;
    if (aRSC) console.log(`  Risk skew:          ${aRSC}`); // T673
    const aHRMC = (a as Record<string, unknown>)['highRiskMethodCount'] as number | undefined;
    if (aHRMC !== undefined && aHRMC > 0) console.log(`  High-risk methods:  ${aHRMC}`); // T678
    const aOBS = (a as Record<string, unknown>)['opsBySeverity'] as {critical: number; high: number; medium: number; low: number} | undefined;
    if (aOBS) console.log(`  Ops by severity:    crit=${aOBS.critical} high=${aOBS.high} med=${aOBS.medium} low=${aOBS.low}`); // T676
    const aRTS = (a as Record<string, unknown>)['riskTrendSlope'] as number | null | undefined;
    if (aRTS !== null && aRTS !== undefined) console.log(`  Risk trend slope:   ${aRTS >= 0 ? '+' : ''}${aRTS.toFixed(4)}`); // T679
    const aARL30 = (a as Record<string, unknown>)['avgRiskLast30m'] as number | null | undefined;
    if (aARL30 !== null && aARL30 !== undefined) console.log(`  Avg risk (30m):     ${(aARL30 * 100).toFixed(1)}%`); // T680
    const aRBM = (a as Record<string, unknown>)['recentBlockedMethods'] as Array<{method: string; blocked: number}> | undefined;
    if (aRBM && aRBM.length > 0) console.log(`  Recent blk methods: ${aRBM.map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T681
    const aUMC = (a as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (aUMC !== undefined) console.log(`  Unique methods:     ${aUMC}`); // T686
    const aATBR = (a as Record<string, unknown>)['topToolsByBlockRate'] as Array<{tool: string; blockRate: number}> | undefined;
    if (aATBR && aATBR.length > 0) console.log(`  Top block-rate tools: ${aATBR.slice(0,3).map(t => `${t.tool}(${(t.blockRate*100).toFixed(0)}%)`).join(', ')}`); // T685
    const aMRSA = (a as Record<string, unknown>)['maxRiskStreak'] as number | undefined;
    if (aMRSA !== undefined && aMRSA > 0) console.log(`  Max risk streak:    ${aMRSA}`); // T690
    const aP99 = (a as Record<string, unknown>)['p99RiskScore'] as number | undefined;
    if (aP99 !== undefined) console.log(`  p99 risk:           ${(aP99 * 100).toFixed(1)}%`); // T691
    const aROL5 = (a as Record<string, unknown>)['recentOpsLast5m'] as number | undefined;
    if (aROL5 !== undefined) console.log(`  Ops last 5m:        ${aROL5}`); // T692
    const aAL = (a as Record<string, unknown>)['alertLevel'] as string | undefined;
    if (aAL) console.log(`  Alert level:        ${aAL.toUpperCase()}`); // T694
    const aBRC = (a as Record<string, unknown>)['blockRateChange'] as number | null | undefined;
    if (aBRC != null) console.log(`  Block rate change:  ${aBRC >= 0 ? '+' : ''}${(aBRC * 100).toFixed(1)}%`); // T695
    const aARC = (a as Record<string, unknown>)['avgRiskChange'] as number | null | undefined;
    if (aARC != null) console.log(`  Avg risk change:    ${aARC >= 0 ? '+' : ''}${(aARC * 100).toFixed(1)}%`); // T696
    const aFHBR = (a as Record<string, unknown>)['firstHalfBlockRate'] as number | null | undefined;
    const aSHBR = (a as Record<string, unknown>)['secondHalfBlockRate'] as number | null | undefined;
    if (aFHBR != null && aSHBR != null) console.log(`  Block rate halves:  ${(aFHBR*100).toFixed(1)}% → ${(aSHBR*100).toFixed(1)}%`); // T697
    const aTRWS = (a as Record<string, unknown>)['topRiskWindowStart'] as string | null | undefined;
    if (aTRWS) console.log(`  Peak risk window:   ${new Date(aTRWS).toLocaleTimeString()}`); // T698
    const aOT24 = (a as Record<string, unknown>)['opsTrend24h'] as number[] | undefined;
    if (aOT24) console.log(`  Ops last 24h:       ${aOT24.reduce((a, b) => a + b, 0)} (peak/h: ${Math.max(...aOT24)})`); // T699
    const aBT24 = (a as Record<string, unknown>)['blockTrend24h'] as number[] | undefined;
    if (aBT24) console.log(`  Blocks last 24h:    ${aBT24.reduce((a, b) => a + b, 0)}`); // T700
    const aRT24 = (a as Record<string, unknown>)['avgRiskTrend24h'] as Array<number | null> | undefined;
    if (aRT24) { const vals = aRT24.filter((v): v is number => v !== null); if (vals.length > 0) console.log(`  Avg risk 24h:       ${(vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1)}%`); } // T701
    const aMD = (a as Record<string, unknown>)['methodDiversity'] as number | undefined;
    if (aMD !== undefined) console.log(`  Method diversity:   ${aMD.toFixed(3)}`); // T702
    const aTD = (a as Record<string, unknown>)['toolDiversity'] as number | undefined;
    if (aTD !== undefined) console.log(`  Tool diversity:     ${aTD.toFixed(3)}`); // T703
    const aHRH = (a as Record<string, unknown>)['highRiskHourCount'] as number | undefined;
    if (aHRH !== undefined && aHRH > 0) console.log(`  High-risk hours:    ${aHRH}/24`); // T704
    const aZOH = (a as Record<string, unknown>)['zeroOpsHourCount'] as number | undefined;
    if (aZOH !== undefined) console.log(`  Zero-ops hours:     ${aZOH}/24`); // T705
    const aBSH = (a as Record<string, unknown>)['blockSpikeHour'] as number | null | undefined;
    if (aBSH != null) console.log(`  Block spike hour:   ${aBSH} hrs ago`); // T706
    const aOSH = (a as Record<string, unknown>)['opsSpikeHour'] as number | null | undefined;
    if (aOSH != null) console.log(`  Ops spike hour:     ${aOSH} hrs ago`); // T707
    const aRV_b = (a as Record<string, unknown>)['riskVolatility'] as number | null | undefined;
    if (aRV_b != null) console.log(`  Risk volatility:    ${(aRV_b * 100).toFixed(1)}%`); // T708
    const aCOC = (a as Record<string, unknown>)['criticalOpsCount'] as number | undefined;
    if (aCOC !== undefined && aCOC > 0) console.log(`  Critical ops (≥0.9): ${aCOC}`); // T709
    const aARBA = (a as Record<string, unknown>)['avgRiskByAction'] as Record<string, number> | undefined;
    if (aARBA) console.log(`  Avg risk by action: allow=${(aARBA['allow']!*100).toFixed(0)}% block=${(aARBA['block']!*100).toFixed(0)}% pending=${(aARBA['require_approval']!*100).toFixed(0)}%`); // T710
    const aRSI = (a as Record<string, unknown>)['recentSessionIds'] as string[] | undefined;
    if (aRSI && aRSI.length > 0) console.log(`  Recent sessions:    ${aRSI.slice(0,3).map(s => s.slice(0,12)).join(', ')}`); // T712
    const aOD = (a as Record<string, unknown>)['opsDensity'] as number | null | undefined;
    if (aOD != null) console.log(`  Ops density:        ${aOD.toFixed(1)}/h`); // T713
    const aBFS = (a as Record<string, unknown>)['blockFreeStreak'] as number | undefined;
    if (aBFS != null && aBFS > 0) console.log(`  Block-free streak:  ${aBFS} ops`); // T714
    const aHRFS = (a as Record<string, unknown>)['highRiskFreeStreak'] as number | undefined;
    if (aHRFS != null && aHRFS > 0) console.log(`  Low-risk streak:    ${aHRFS} ops`); // T715
    const aAOBB = (a as Record<string, unknown>)['avgOpsBetweenBlocks'] as number | null | undefined;
    if (aAOBB != null) console.log(`  Avg ops/block gap:  ${aAOBB.toFixed(1)}`); // T716
    const aRRT = (a as Record<string, unknown>)['recentRiskTrend'] as string | undefined;
    if (aRRT) console.log(`  Recent risk trend:  ${aRRT}`); // T717
    const aCS = (a as Record<string, unknown>)['coverageScore'] as number | undefined;
    if (aCS != null) console.log(`  24h coverage:       ${(aCS * 100).toFixed(0)}%`); // T718
    const aPHOD = (a as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (aPHOD != null) console.log(`  Peak hour:          h-${aPHOD}`); // T719
    const aQHOD = (a as Record<string, unknown>)['quietHourOfDay'] as number | null | undefined;
    if (aQHOD != null) console.log(`  Quiet hour:         h-${aQHOD}`); // T720
    const aBRL_b = (a as Record<string, unknown>)['blockRunLengthMax'] as number | undefined;
    if (aBRL_b != null && aBRL_b > 0) console.log(`  Max block run:      ${aBRL_b}`); // T721
    const aARL = (a as Record<string, unknown>)['allowRunLengthMax'] as number | undefined;
    if (aARL != null && aARL > 0) console.log(`  Max allow run:      ${aARL}`); // T722
    const aRIQR = (a as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (aRIQR != null) console.log(`  Risk IQR:           ${aRIQR.toFixed(3)}`); // T723
    const aMR = (a as Record<string, unknown>)['medianRisk'] as number | null | undefined;
    if (aMR != null) console.log(`  Median risk:        ${aMR.toFixed(3)}`); // T724
    const aP90 = (a as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (aP90 != null) console.log(`  P90 risk:           ${aP90.toFixed(3)}`); // T725
    const aBRLH = (a as Record<string, unknown>)['blockRateLastHour'] as number | null | undefined;
    if (aBRLH != null) console.log(`  Block rate (1h):    ${(aBRLH * 100).toFixed(1)}%`); // T726
    const aARLH = (a as Record<string, unknown>)['approvalRateLastHour'] as number | null | undefined;
    if (aARLH != null) console.log(`  Approval rate (1h): ${(aARLH * 100).toFixed(1)}%`); // T727
    const aUTC = (a as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
    if (aUTC != null) console.log(`  Unique tools:       ${aUTC}`); // T728
    const aRSD = (a as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (aRSD != null) console.log(`  Risk std dev:       ${aRSD.toFixed(3)}`); // T729
    const aFOT = (a as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (aFOT) console.log(`  First op:           ${aFOT}`); // T730
    const aLOT = (a as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (aLOT) console.log(`  Last op:            ${aLOT}`); // T731
    const aTBT = (a as Record<string, unknown>)['topBlockedTool'] as string | null | undefined;
    if (aTBT) console.log(`  Top blocked tool:   ${aTBT}`); // T732
    const aARL10 = (a as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (aARL10 != null) console.log(`  Avg risk (last 10): ${aARL10.toFixed(3)}`); // T733
    const aBRLD = (a as Record<string, unknown>)['blockRateLastDay'] as number | null | undefined;
    if (aBRLD != null) console.log(`  Block rate (24h):   ${(aBRLD * 100).toFixed(1)}%`); // T734
    const aTAT = (a as Record<string, unknown>)['topAllowedTool'] as string | null | undefined;
    if (aTAT) console.log(`  Top allowed tool:   ${aTAT}`); // T735
    const aRBOI = (a as Record<string, unknown>)['recentBlockedOpIds'] as string[] | undefined;
    if (aRBOI && aRBOI.length > 0) console.log(`  Recent blocked ops: ${aRBOI.map(id => id.slice(0,8)).join(', ')}`); // T736
    const aRAOI = (a as Record<string, unknown>)['recentApprovedOpIds'] as string[] | undefined;
    if (aRAOI && aRAOI.length > 0) console.log(`  Recent pending ops: ${aRAOI.map(id => id.slice(0,8)).join(', ')}`); // T737
    const aSC = (a as Record<string, unknown>)['sessionCount'] as number | undefined;
    if (aSC != null) console.log(`  Distinct sessions:  ${aSC}`); // T738
    const aMinR = (a as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (aMinR != null) console.log(`  Min risk:           ${aMinR.toFixed(3)}`); // T739
    const aMaxR = (a as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (aMaxR != null) console.log(`  Max risk:           ${aMaxR.toFixed(3)}`); // T740
    const aARF10 = (a as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (aARF10 != null) console.log(`  Avg risk (first 10):${aARF10.toFixed(3)}`); // T741
    const aRDFL = (a as Record<string, unknown>)['riskDeltaFirstLast'] as number | null | undefined;
    if (aRDFL != null) console.log(`  Risk delta F→L:     ${aRDFL >= 0 ? '+' : ''}${aRDFL.toFixed(3)}`); // T742
    const aAM = (a as Record<string, unknown>)['activeMinutes'] as number | null | undefined;
    if (aAM != null) console.log(`  Active span:        ${aAM.toFixed(1)}m`); // T743
    const aRSkew = (a as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (aRSkew != null) console.log(`  Risk skewness:      ${aRSkew.toFixed(3)}`); // T744
    const aOB5 = (a as Record<string, unknown>)['opsBurst5m'] as number | undefined;
    if (aOB5 != null) console.log(`  Ops burst (5m):     ${aOB5}`); // T745
    const aBB5 = (a as Record<string, unknown>)['blockBurst5m'] as number | undefined;
    if (aBB5 != null && aBB5 > 0) console.log(`  Block burst (5m):   ${aBB5}`); // T746
    const aAIMs = (a as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (aAIMs != null) console.log(`  Avg interval:       ${(aAIMs/1000).toFixed(1)}s`); // T747
    const aLGMs = (a as Record<string, unknown>)['longestGapMs'] as number | null | undefined;
    if (aLGMs != null) console.log(`  Longest gap:        ${(aLGMs/1000).toFixed(1)}s`); // T748
    const aKurt = (a as Record<string, unknown>)['kurtosis'] as number | null | undefined;
    if (aKurt != null) console.log(`  Kurtosis:           ${aKurt.toFixed(3)}`); // T749
    const aCHRM = (a as Record<string, unknown>)['consecutiveHighRiskMax'] as number | undefined;
    if (aCHRM != null && aCHRM > 0) console.log(`  Max hi-risk streak: ${aCHRM}`); // T753
    const aCLRM = (a as Record<string, unknown>)['consecutiveLowRiskMax'] as number | undefined;
    if (aCLRM != null && aCLRM > 0) console.log(`  Max lo-risk streak: ${aCLRM}`); // T751
    const aRBF = (a as Record<string, unknown>)['riskBucketsFine'] as number[] | undefined;
    if (aRBF && aRBF.some(v => v > 0)) console.log(`  Risk buckets(fine): ${aRBF.join('|')}`); // T752
    const aRWBR = (a as Record<string, unknown>)['riskWeightedBlockRate'] as number | null | undefined;
    if (aRWBR != null) console.log(`  Risk-wtd blk rate:  ${(aRWBR*100).toFixed(1)}%`); // T754
    const aAPC = (a as Record<string, unknown>)['approvalPendingCount'] as number | undefined;
    if (aAPC != null && aAPC > 0) console.log(`  Pending approvals:  ${aAPC}`); // T755
    const aTMBO = (a as Record<string, unknown>)['topMethodByOps'] as string | null | undefined;
    if (aTMBO) console.log(`  Top method (ops):   ${aTMBO}`); // T756
    const aTMBR = (a as Record<string, unknown>)['topMethodByRisk'] as string | null | undefined;
    if (aTMBR) console.log(`  Top method (risk):  ${aTMBR}`); // T757
    const aR99 = (a as Record<string, unknown>)['riskScore99p'] as number | null | undefined;
    if (aR99 != null) console.log(`  P99 risk:           ${aR99.toFixed(3)}`); // T758
    const aUMC_b = (a as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
    if (aUMC_b != null) console.log(`  Unique methods:     ${aUMC_b}`); // T759
    const aR10 = (a as Record<string, unknown>)['riskScore10p'] as number | null | undefined;
    if (aR10 != null) console.log(`  P10 risk:           ${aR10.toFixed(3)}`); // T762
    const aR75 = (a as Record<string, unknown>)['riskScore75p'] as number | null | undefined;
    if (aR75 != null) console.log(`  P75 risk:           ${aR75.toFixed(3)}`); // T763
    const aR25 = (a as Record<string, unknown>)['riskScore25p'] as number | null | undefined;
    if (aR25 != null) console.log(`  P25 risk:           ${aR25.toFixed(3)}`); // T766
    const aREB = (a as Record<string, unknown>)['riskEntropyBuckets'] as number | undefined;
    if (aREB != null) console.log(`  Risk entropy:       ${aREB.toFixed(3)}`); // T767
    const aART = (a as Record<string, unknown>)['avgRiskByTool'] as Record<string, number> | undefined;
    if (aART && Object.keys(aART).length > 0) { const top3 = Object.entries(aART).sort((a2, b) => b[1] - a2[1]).slice(0, 3).map(([k, v]) => `${k}:${(v*100).toFixed(0)}%`).join(' '); console.log(`  Avg risk/tool:      ${top3}`); } // T768
    const aBCT = (a as Record<string, unknown>)['blockCountByTool'] as Record<string, number> | undefined;
    if (aBCT && Object.keys(aBCT).length > 0) { const top3 = Object.entries(aBCT).sort((a2, b) => b[1] - a2[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Blocks/tool:        ${top3}`); } // T769
    const aACT = (a as Record<string, unknown>)['allowCountByTool'] as Record<string, number> | undefined;
    if (aACT && Object.keys(aACT).length > 0) { const top3 = Object.entries(aACT).sort((a2, b) => b[1] - a2[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Allows/tool:        ${top3}`); } // T770
    const aOL5 = (a as Record<string, unknown>)['opsLast5m'] as number | undefined;
    if (aOL5 != null) console.log(`  Ops last 5m:        ${aOL5}`); // T771
    const aBL5 = (a as Record<string, unknown>)['blocksLast5m'] as number | undefined;
    if (aBL5 != null) console.log(`  Blocks last 5m:     ${aBL5}`); // T772
    const aHRI = (a as Record<string, unknown>)['highRiskOpIds'] as string[] | undefined;
    if (aHRI && aHRI.length > 0) console.log(`  High risk op IDs:   ${aHRI.slice(0, 3).join(' ')}`); // T773
    const aARP = (a as Record<string, unknown>)['approvalRatePercent'] as number | null | undefined;
    if (aARP != null) console.log(`  Approval rate:      ${aARP.toFixed(1)}%`); // T774
    const aRCR = (a as Record<string, unknown>)['riskChangeRate'] as number | null | undefined;
    if (aRCR != null) console.log(`  Risk change rate:   ${aRCR.toFixed(3)}`); // T775
    const aDD = (a as Record<string, unknown>)['decisionDistribution'] as Record<string, number> | undefined;
    if (aDD) console.log(`  Decisions:          allow=${aDD['allow']} block=${aDD['block']} approval=${aDD['require_approval']}`); // T776
    const aOT = (a as Record<string, unknown>)['opsTrend12h'] as number | null | undefined;
    if (aOT != null) console.log(`  Ops trend 12h:      ${aOT.toFixed(2)}x`); // T777
    const aARB = (a as Record<string, unknown>)['avgRiskOfBlocked'] as number | null | undefined;
    if (aARB != null) console.log(`  Avg risk blocked:   ${aARB.toFixed(3)}`); // T778
    const aARA = (a as Record<string, unknown>)['avgRiskOfAllowed'] as number | null | undefined;
    if (aARA != null) console.log(`  Avg risk allowed:   ${aARA.toFixed(3)}`); // T779
    const aRGB = (a as Record<string, unknown>)['riskGapBlockVsAllow'] as number | null | undefined;
    if (aRGB != null) console.log(`  Risk gap b-a:       ${aRGB.toFixed(3)}`); // T780
    const aOL1 = (a as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (aOL1 != null) console.log(`  Ops last 1h:        ${aOL1}`); // T781
    const aBL1 = (a as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (aBL1 != null) console.log(`  Blocks last 1h:     ${aBL1}`); // T782
    const aBRO = (a as Record<string, unknown>)['blockRateOverall'] as number | null | undefined;
    if (aBRO != null) console.log(`  Block rate overall: ${(aBRO*100).toFixed(1)}%`); // T783
    const aARO = (a as Record<string, unknown>)['allowRateOverall'] as number | null | undefined;
    if (aARO != null) console.log(`  Allow rate overall: ${(aARO*100).toFixed(1)}%`); // T784
    const aACO = (a as Record<string, unknown>)['approvalCountOverall'] as number | undefined;
    if (aACO != null) console.log(`  Approval count:     ${aACO}`); // T785
    const aRB = (a as Record<string, unknown>)['riskBand'] as string | undefined;
    if (aRB) console.log(`  Risk band:          ${aRB}`); // T786
    const aRAI = (a as Record<string, unknown>)['recentAllowedOpIds'] as string[] | undefined;
    if (aRAI && aRAI.length > 0) console.log(`  Recent allow IDs:   ${aRAI.slice(0, 3).join(' ')}`); // T787
    const aP95 = (a as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (aP95 != null) console.log(`  P95 risk:           ${aP95.toFixed(3)}`); // T788
    const aRCV = (a as Record<string, unknown>)['riskCV'] as number | null | undefined;
    if (aRCV != null) console.log(`  Risk CV:            ${aRCV.toFixed(3)}`); // T789
    const aBSC = (a as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (aBSC != null && aBSC > 0) console.log(`  Block streak now:   ${aBSC}`); // T790
    const aASC = (a as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (aASC != null && aASC > 0) console.log(`  Allow streak now:   ${aASC}`); // T791
    const aRM = (a as Record<string, unknown>)['riskMomentum'] as number | null | undefined;
    if (aRM != null) console.log(`  Risk momentum:      ${aRM.toFixed(3)}`); // T792
    const aOPA = (a as Record<string, unknown>)['opsPerAgent'] as number | null | undefined;
    if (aOPA != null) console.log(`  Ops per agent:      ${aOPA.toFixed(1)}`); // T793
    const aOPT = (a as Record<string, unknown>)['opsPerTool'] as number | null | undefined;
    if (aOPT != null) console.log(`  Ops per tool:       ${aOPT.toFixed(1)}`); // T794
    const aHRBC = (a as Record<string, unknown>)['highRiskBlockCount'] as number | undefined;
    if (aHRBC != null) console.log(`  High-risk blocks:   ${aHRBC}`); // T796
    const aLRAC = (a as Record<string, unknown>)['lowRiskAllowCount'] as number | undefined;
    if (aLRAC != null) console.log(`  Low-risk allows:    ${aLRAC}`); // T797
    const aRTHD = (a as Record<string, unknown>)['riskTrendHalfDay'] as number | null | undefined;
    if (aRTHD != null) console.log(`  Risk trend 12h:     ${aRTHD > 0 ? '+' : ''}${aRTHD.toFixed(3)}`); // T798
    const aMIM = (a as Record<string, unknown>)['medianIntervalMs'] as number | null | undefined;
    if (aMIM != null) console.log(`  Median interval:    ${aMIM.toFixed(0)}ms`); // T799
    const aBRL6 = (a as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (aBRL6 != null) console.log(`  Block rate 6h:      ${(aBRL6*100).toFixed(1)}%`); // T800
    const aARL6 = (a as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (aARL6 != null) console.log(`  Allow rate 6h:      ${(aARL6*100).toFixed(1)}%`); // T801
    const aRDS = (a as Record<string, unknown>)['riskDecayScore'] as number | null | undefined;
    if (aRDS != null) console.log(`  Risk decay score:   ${aRDS.toFixed(3)}`); // T802
    const aROI = (a as Record<string, unknown>)['recentOpIds'] as string[] | undefined;
    if (aROI && aROI.length > 0) console.log(`  Recent op IDs:      ${aROI.slice(0, 3).join(' ')}`); // T803
    const aBRL3 = (a as Record<string, unknown>)['blockRateLast3h'] as number | null | undefined;
    if (aBRL3 != null) console.log(`  Block rate 3h:      ${(aBRL3*100).toFixed(1)}%`); // T804
    const aARL3 = (a as Record<string, unknown>)['allowRateLast3h'] as number | null | undefined;
    if (aARL3 != null) console.log(`  Allow rate 3h:      ${(aARL3*100).toFixed(1)}%`); // T805
    const aOL3 = (a as Record<string, unknown>)['opsLast3h'] as number | undefined;
    if (aOL3 != null) console.log(`  Ops last 3h:        ${aOL3}`); // T806
    const aTABO = (a as Record<string, unknown>)['topAgentByOps'] as string | null | undefined;
    if (aTABO) console.log(`  Top agent (ops):    ${aTABO}`); // T807
    const aTABR = (a as Record<string, unknown>)['topAgentByRisk'] as string | null | undefined;
    if (aTABR) console.log(`  Top agent (risk):   ${aTABR}`); // T808
    const aTTBO = (a as Record<string, unknown>)['topToolByOps'] as string | null | undefined;
    if (aTTBO) console.log(`  Top tool (ops):     ${aTTBO}`); // T809
    const aTTBR = (a as Record<string, unknown>)['topToolByRisk'] as string | null | undefined;
    if (aTTBR) console.log(`  Top tool (risk):    ${aTTBR}`); // T810
    const aBCL24 = (a as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (aBCL24 != null) console.log(`  Blocks last 24h:    ${aBCL24}`); // T811
    const aACL24 = (a as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (aACL24 != null) console.log(`  Allows last 24h:    ${aACL24}`); // T812
    const aAPCL24 = (a as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (aAPCL24 != null) console.log(`  Approvals last 24h: ${aAPCL24}`); // T813
    const aRAMC = (a as Record<string, unknown>)['riskAboveMedianCount'] as number | undefined;
    if (aRAMC != null) console.log(`  Risk above median:  ${aRAMC}`); // T814
    const aRBMC = (a as Record<string, unknown>)['riskBelowMedianCount'] as number | undefined;
    if (aRBMC != null) console.log(`  Risk below median:  ${aRBMC}`); // T815
    const aBD = (a as Record<string, unknown>)['blockDensity'] as number | null | undefined;
    if (aBD != null) console.log(`  Block density:      ${aBD.toFixed(1)}/1k`); // T816
    const aAD = (a as Record<string, unknown>)['approvalDensity'] as number | null | undefined;
    if (aAD != null) console.log(`  Approval density:   ${aAD.toFixed(1)}/1k`); // T817
    const aRVR = (a as Record<string, unknown>)['riskVolatilityRecent'] as number | null | undefined;
    if (aRVR != null) console.log(`  Risk vol (recent):  ${aRVR.toFixed(3)}`); // T818
    const aRHBC = (a as Record<string, unknown>)['riskHighBandCount'] as number | undefined;
    if (aRHBC != null) console.log(`  Risk high (>=0.7):  ${aRHBC}`); // T819
    const aRLBC = (a as Record<string, unknown>)['riskLowBandCount'] as number | undefined;
    if (aRLBC != null) console.log(`  Risk low (<0.3):    ${aRLBC}`); // T820
    const aRMBC = (a as Record<string, unknown>)['riskMidBandCount'] as number | undefined;
    if (aRMBC != null) console.log(`  Risk mid (0.3-0.7): ${aRMBC}`); // T821
    const aHSFO = (a as Record<string, unknown>)['hoursSinceFirstOp'] as number | null | undefined;
    if (aHSFO != null) console.log(`  Hours since 1st op: ${aHSFO.toFixed(1)}`); // T822
    const aHSLO = (a as Record<string, unknown>)['hoursSinceLastOp'] as number | null | undefined;
    if (aHSLO != null) console.log(`  Hours since last op:${aHSLO.toFixed(1)}`); // T823
    const aOL30 = (a as Record<string, unknown>)['opsLast30m'] as number | undefined;
    if (aOL30 != null) console.log(`  Ops last 30m:       ${aOL30}`); // T824
    const aBL30 = (a as Record<string, unknown>)['blocksLast30m'] as number | undefined;
    if (aBL30 != null) console.log(`  Blocks last 30m:    ${aBL30}`); // T825
    const aTSO = (a as Record<string, unknown>)['topSessionByOps'] as string | null | undefined;
    if (aTSO != null) console.log(`  Top sess (ops):     ${aTSO}`); // T826
    const aTSR_b = (a as Record<string, unknown>)['topSessionByRisk'] as string | null | undefined;
    if (aTSR_b != null) console.log(`  Top sess (risk):    ${aTSR_b}`); // T827
    const aUSC = (a as Record<string, unknown>)['uniqueSessionCount'] as number | undefined;
    if (aUSC != null) console.log(`  Unique sessions:    ${aUSC}`); // T828
    const aUAC = (a as Record<string, unknown>)['uniqueAgentCount'] as number | undefined;
    if (aUAC != null) console.log(`  Unique agents:      ${aUAC}`); // T829
    const aUTC_b = (a as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
    if (aUTC_b != null) console.log(`  Unique tools:       ${aUTC_b}`); // T830
    const aAOS = (a as Record<string, unknown>)['avgOpsPerSession'] as number | null | undefined;
    if (aAOS != null) console.log(`  Avg ops/session:    ${aAOS.toFixed(1)}`); // T831
    const aTTB = (a as Record<string, unknown>)['topToolByBlocks'] as string | null | undefined;
    if (aTTB != null) console.log(`  Top tool (blocks):  ${aTTB}`); // T832
    const aTAB = (a as Record<string, unknown>)['topAgentByBlocks'] as string | null | undefined;
    if (aTAB != null) console.log(`  Top agent (blocks): ${aTAB}`); // T833
    const aBRL24 = (a as Record<string, unknown>)['blockRateLast24h'] as number | null | undefined;
    if (aBRL24 != null) console.log(`  Block rate 24h:     ${(aBRL24 * 100).toFixed(1)}%`); // T834
    const aARL24 = (a as Record<string, unknown>)['allowRateLast24h'] as number | null | undefined;
    if (aARL24 != null) console.log(`  Allow rate 24h:     ${(aARL24 * 100).toFixed(1)}%`); // T835
    const aAPRL24 = (a as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (aAPRL24 != null) console.log(`  Approval rate 24h:  ${(aAPRL24 * 100).toFixed(1)}%`); // T836
    const aMCB = (a as Record<string, unknown>)['maxConsecutiveBlocks'] as number | undefined;
    if (aMCB != null) console.log(`  Max consec blocks:  ${aMCB}`); // T837
    const aMCA = (a as Record<string, unknown>)['maxConsecutiveAllows'] as number | undefined;
    if (aMCA != null) console.log(`  Max consec allows:  ${aMCA}`); // T838
    const aRSK = (a as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
    if (aRSK != null) console.log(`  Risk skewness:      ${aRSK.toFixed(3)}`); // T839
    const aRKT = (a as Record<string, unknown>)['riskKurtosis'] as number | null | undefined;
    if (aRKT != null) console.log(`  Risk kurtosis:      ${aRKT.toFixed(3)}`); // T840
    const aOL15 = (a as Record<string, unknown>)['opsLast15m'] as number | undefined;
    if (aOL15 != null) console.log(`  Ops last 15m:       ${aOL15}`); // T841
    const aBL15 = (a as Record<string, unknown>)['blocksLast15m'] as number | undefined;
    if (aBL15 != null) console.log(`  Blocks last 15m:    ${aBL15}`); // T842
    const aHRR_b = (a as Record<string, unknown>)['highRiskRateOverall'] as number | null | undefined;
    if (aHRR_b != null) console.log(`  High-risk rate:     ${(aHRR_b * 100).toFixed(1)}%`); // T843
    const aLRR_b = (a as Record<string, unknown>)['lowRiskRateOverall'] as number | null | undefined;
    if (aLRR_b != null) console.log(`  Low-risk rate:      ${(aLRR_b * 100).toFixed(1)}%`); // T844
    const aMRR_b = (a as Record<string, unknown>)['midRiskRateOverall'] as number | null | undefined;
    if (aMRR_b != null) console.log(`  Mid-risk rate:      ${(aMRR_b * 100).toFixed(1)}%`); // T845
    const aRRG = (a as Record<string, unknown>)['riskRange'] as number | null | undefined;
    if (aRRG != null) console.log(`  Risk range:         ${aRRG.toFixed(3)}`); // T846
    const aFOT_b = (a as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
    if (aFOT_b != null) console.log(`  First op at:        ${aFOT_b}`); // T847
    const aLOT_b = (a as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
    if (aLOT_b != null) console.log(`  Last op at:         ${aLOT_b}`); // T848
    const aTDMs = (a as Record<string, unknown>)['totalDurationMs'] as number | null | undefined;
    if (aTDMs != null) console.log(`  Total duration:     ${(aTDMs / 3600000).toFixed(1)}h`); // T849
    const aOPH = (a as Record<string, unknown>)['opsPerHour'] as number | null | undefined;
    if (aOPH != null) console.log(`  Ops per hour:       ${aOPH.toFixed(1)}`); // T850
    const aBPH = (a as Record<string, unknown>)['blocksPerHour'] as number | null | undefined;
    if (aBPH != null) console.log(`  Blocks per hour:    ${aBPH.toFixed(1)}`); // T851
    const aRWBC = (a as Record<string, unknown>)['riskWeightedBlockCount'] as number | undefined;
    if (aRWBC != null) console.log(`  Risk-wtd blocks:    ${aRWBC.toFixed(2)}`); // T852
    const aRWAC = (a as Record<string, unknown>)['riskWeightedAllowCount'] as number | undefined;
    if (aRWAC != null) console.log(`  Risk-wtd allows:    ${aRWAC.toFixed(2)}`); // T853
    const aARL10_b = (a as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
    if (aARL10_b != null) console.log(`  Avg risk last 10:   ${aARL10_b.toFixed(3)}`); // T854
    const aARF10_b = (a as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
    if (aARF10_b != null) console.log(`  Avg risk first 10:  ${aARF10_b.toFixed(3)}`); // T855
    const aRTF10 = (a as Record<string, unknown>)['riskTrendFirst10vsLast10'] as number | null | undefined;
    if (aRTF10 != null) console.log(`  Risk trend (10):    ${aRTF10 >= 0 ? '+' : ''}${aRTF10.toFixed(3)}`); // T856
    const aBCL7 = (a as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (aBCL7 != null) console.log(`  Blocks last 7d:     ${aBCL7}`); // T857
    const aACL7 = (a as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (aACL7 != null) console.log(`  Allows last 7d:     ${aACL7}`); // T858
    const aAPCL7 = (a as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (aAPCL7 != null) console.log(`  Approvals last 7d:  ${aAPCL7}`); // T859
    const aOCL7 = (a as Record<string, unknown>)['opsCountLast7d'] as number | undefined;
    if (aOCL7 != null) console.log(`  Ops last 7d:        ${aOCL7}`); // T860
    const aRSA = (a as Record<string, unknown>)['riskSumAll'] as number | undefined;
    if (aRSA != null) console.log(`  Risk sum (all):     ${aRSA.toFixed(2)}`); // T861
    const aAIM = (a as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
    if (aAIM != null) console.log(`  Avg interval:       ${(aAIM / 1000).toFixed(1)}s`); // T862
    const aMNR = (a as Record<string, unknown>)['minRisk'] as number | null | undefined;
    if (aMNR != null) console.log(`  Min risk:           ${aMNR.toFixed(3)}`); // T863
    const aMXR = (a as Record<string, unknown>)['maxRisk'] as number | null | undefined;
    if (aMXR != null) console.log(`  Max risk:           ${aMXR.toFixed(3)}`); // T864
    const aRIQR_b = (a as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (aRIQR_b != null) console.log(`  Risk IQR:           ${aRIQR_b.toFixed(3)}`); // T865
    const aBRC1 = (a as Record<string, unknown>)['blockRateChange1h'] as number | undefined;
    if (aBRC1 != null) console.log(`  Block rate Δ1h:     ${aBRC1 >= 0 ? '+' : ''}${(aBRC1 * 100).toFixed(1)}%`); // T866
    const aOT1 = (a as Record<string, unknown>)['opsTrend1h'] as number | null | undefined;
    if (aOT1 != null) console.log(`  Ops trend 1h:       ${aOT1.toFixed(2)}x`); // T867
    const aBT6 = (a as Record<string, unknown>)['blockTrend6h'] as number | null | undefined;
    if (aBT6 != null) console.log(`  Block trend 6h:     ${aBT6.toFixed(2)}x`); // T868
    const aAT6 = (a as Record<string, unknown>)['allowTrend6h'] as number | null | undefined;
    if (aAT6 != null) console.log(`  Allow trend 6h:     ${aAT6.toFixed(2)}x`); // T869
    const aBRA = (a as Record<string, unknown>)['blockRatioToAllow'] as number | null | undefined;
    if (aBRA != null) console.log(`  Block/allow ratio:  ${aBRA.toFixed(2)}`); // T870
    const aARB_b = (a as Record<string, unknown>)['approvalRatioToBlock'] as number | null | undefined;
    if (aARB_b != null) console.log(`  Approval/block:     ${aARB_b.toFixed(2)}`); // T871
    const aOL2 = (a as Record<string, unknown>)['opsLast2h'] as number | undefined;
    if (aOL2 != null) console.log(`  Ops last 2h:        ${aOL2}`); // T872
    const aBL2 = (a as Record<string, unknown>)['blocksLast2h'] as number | undefined;
    if (aBL2 != null) console.log(`  Blocks last 2h:     ${aBL2}`); // T873
    const aAL2 = (a as Record<string, unknown>)['allowsLast2h'] as number | undefined;
    if (aAL2 != null) console.log(`  Allows last 2h:     ${aAL2}`); // T874
    const aOL4 = (a as Record<string, unknown>)['opsLast4h'] as number | undefined;
    if (aOL4 != null) console.log(`  Ops last 4h:        ${aOL4}`); // T875
    const aBL4 = (a as Record<string, unknown>)['blocksLast4h'] as number | undefined;
    if (aBL4 != null) console.log(`  Blocks last 4h:     ${aBL4}`); // T876
    const aBR4 = (a as Record<string, unknown>)['blockRateLast4h'] as number | null | undefined;
    if (aBR4 != null) console.log(`  Block rate 4h:      ${(aBR4 * 100).toFixed(1)}%`); // T877
    const aRSD_b = (a as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
    if (aRSD_b != null) console.log(`  Risk std dev:       ${aRSD_b.toFixed(3)}`); // T878
    const aAL4 = (a as Record<string, unknown>)['allowsLast4h'] as number | undefined;
    if (aAL4 != null) console.log(`  Allows last 4h:     ${aAL4}`); // T879
    const aAR4 = (a as Record<string, unknown>)['allowRateLast4h'] as number | null | undefined;
    if (aAR4 != null) console.log(`  Allow rate 4h:      ${(aAR4 * 100).toFixed(1)}%`); // T880
    const aOL12 = (a as Record<string, unknown>)['opsLast12h'] as number | undefined;
    if (aOL12 != null) console.log(`  Ops last 12h:       ${aOL12}`); // T881
    const aBL12 = (a as Record<string, unknown>)['blocksLast12h'] as number | undefined;
    if (aBL12 != null) console.log(`  Blocks last 12h:    ${aBL12}`); // T882
    const aAL12 = (a as Record<string, unknown>)['allowsLast12h'] as number | undefined;
    if (aAL12 != null) console.log(`  Allows last 12h:    ${aAL12}`); // T883
    const aBR12 = (a as Record<string, unknown>)['blockRateLast12h'] as number | null | undefined;
    if (aBR12 != null) console.log(`  Block rate 12h:     ${(aBR12 * 100).toFixed(1)}%`); // T884
    const aAR12 = (a as Record<string, unknown>)['allowRateLast12h'] as number | null | undefined;
    if (aAR12 != null) console.log(`  Allow rate 12h:     ${(aAR12 * 100).toFixed(1)}%`); // T885
    const aOL48 = (a as Record<string, unknown>)['opsLast48h'] as number | undefined;
    if (aOL48 != null) console.log(`  Ops last 48h:       ${aOL48}`); // T886
    const aBL48 = (a as Record<string, unknown>)['blocksLast48h'] as number | undefined;
    if (aBL48 != null) console.log(`  Blocks last 48h:    ${aBL48}`); // T887
    const aAL48 = (a as Record<string, unknown>)['allowsLast48h'] as number | undefined;
    if (aAL48 != null) console.log(`  Allows last 48h:    ${aAL48}`); // T888
    const aBR48 = (a as Record<string, unknown>)['blockRateLast48h'] as number | null | undefined;
    if (aBR48 != null) console.log(`  Block rate 48h:     ${(aBR48 * 100).toFixed(1)}%`); // T889
    const aAR48 = (a as Record<string, unknown>)['allowRateLast48h'] as number | null | undefined;
    if (aAR48 != null) console.log(`  Allow rate 48h:     ${(aAR48 * 100).toFixed(1)}%`); // T890
    const aAPC24 = (a as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (aAPC24 != null) console.log(`  Approvals last 24h: ${aAPC24}`); // T891
    const aAPR24 = (a as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (aAPR24 != null) console.log(`  Approval rate 24h:  ${(aAPR24 * 100).toFixed(1)}%`); // T892
    const aRCV_b = (a as Record<string, unknown>)['riskCvPct'] as number | null | undefined;
    if (aRCV_b != null) console.log(`  Risk CV%:           ${aRCV_b.toFixed(1)}%`); // T893
    const aAPC48 = (a as Record<string, unknown>)['approvalCountLast48h'] as number | undefined;
    if (aAPC48 != null) console.log(`  Approvals last 48h: ${aAPC48}`); // T894
    const aAPC12 = (a as Record<string, unknown>)['approvalCountLast12h'] as number | undefined;
    if (aAPC12 != null) console.log(`  Approvals last 12h: ${aAPC12}`); // T895
    const aP50 = (a as Record<string, unknown>)['p50Risk'] as number | null | undefined;
    if (aP50 != null) console.log(`  Risk p50:           ${aP50.toFixed(3)}`); // T896
    const aP90_b = (a as Record<string, unknown>)['p90Risk'] as number | null | undefined;
    if (aP90_b != null) console.log(`  Risk p90:           ${aP90_b.toFixed(3)}`); // T897
    const aP10 = (a as Record<string, unknown>)['p10Risk'] as number | null | undefined;
    if (aP10 != null) console.log(`  Risk p10:           ${aP10.toFixed(3)}`); // T898
    const aBC30d = (a as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (aBC30d != null) console.log(`  Blocks last 30d:    ${aBC30d}`); // T899
    const aAC30d = (a as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (aAC30d != null) console.log(`  Allows last 30d:    ${aAC30d}`); // T900
    const aOL30d = (a as Record<string, unknown>)['opsLast30d'] as number | undefined;
    if (aOL30d != null) console.log(`  Ops last 30d:       ${aOL30d}`); // T901
    const aBR30d = (a as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (aBR30d != null) console.log(`  Block rate 30d:     ${(aBR30d * 100).toFixed(1)}%`); // T902
    const aAR30d = (a as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (aAR30d != null) console.log(`  Avg risk 30d:       ${aAR30d.toFixed(3)}`); // T903
    const aAPR48 = (a as Record<string, unknown>)['approvalRateLast48h'] as number | null | undefined;
    if (aAPR48 != null) console.log(`  Approval rate 48h:  ${(aAPR48 * 100).toFixed(1)}%`); // T904
    const aAPR12 = (a as Record<string, unknown>)['approvalRateLast12h'] as number | null | undefined;
    if (aAPR12 != null) console.log(`  Approval rate 12h:  ${(aAPR12 * 100).toFixed(1)}%`); // T905
    const aAPR30d = (a as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (aAPR30d != null) console.log(`  Approval rate 30d:  ${(aAPR30d * 100).toFixed(1)}%`); // T906
    const aHRC24 = (a as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (aHRC24 != null) console.log(`  High risk last 24h: ${aHRC24}`); // T907
    const aHRC7d = (a as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (aHRC7d != null) console.log(`  High risk last 7d:  ${aHRC7d}`); // T908
    const aHRC30d = (a as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (aHRC30d != null) console.log(`  High risk last 30d: ${aHRC30d}`); // T909
    const aLRC24 = (a as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (aLRC24 != null) console.log(`  Low risk last 24h:  ${aLRC24}`); // T910
    const aLRC7d = (a as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (aLRC7d != null) console.log(`  Low risk last 7d:   ${aLRC7d}`); // T911
    const aARL7d = (a as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (aARL7d != null) console.log(`  Avg risk 7d:        ${aARL7d.toFixed(3)}`); // T912
    const aARL24_b = (a as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (aARL24_b != null) console.log(`  Avg risk 24h:       ${aARL24_b.toFixed(3)}`); // T913
    const aARL48 = (a as Record<string, unknown>)['avgRiskLast48h'] as number | null | undefined;
    if (aARL48 != null) console.log(`  Avg risk 48h:       ${aARL48.toFixed(3)}`); // T914
    const aARL12 = (a as Record<string, unknown>)['avgRiskLast12h'] as number | null | undefined;
    if (aARL12 != null) console.log(`  Avg risk 12h:       ${aARL12.toFixed(3)}`); // T915
    const aLRC30d = (a as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (aLRC30d != null) console.log(`  Low risk last 30d:  ${aLRC30d}`); // T916
    const aLRC48 = (a as Record<string, unknown>)['lowRiskCountLast48h'] as number | undefined;
    if (aLRC48 != null) console.log(`  Low risk last 48h:  ${aLRC48}`); // T917
    const aLRC12 = (a as Record<string, unknown>)['lowRiskCountLast12h'] as number | undefined;
    if (aLRC12 != null) console.log(`  Low risk last 12h:  ${aLRC12}`); // T918
    const aHRC48 = (a as Record<string, unknown>)['highRiskCountLast48h'] as number | undefined;
    if (aHRC48 != null) console.log(`  High risk last 48h: ${aHRC48}`); // T919
    const aHRC12 = (a as Record<string, unknown>)['highRiskCountLast12h'] as number | undefined;
    if (aHRC12 != null) console.log(`  High risk last 12h: ${aHRC12}`); // T920
    const aMRC24 = (a as Record<string, unknown>)['midRiskCountLast24h'] as number | undefined;
    if (aMRC24 != null) console.log(`  Mid risk last 24h:  ${aMRC24}`); // T921
    const aMRC7d = (a as Record<string, unknown>)['midRiskCountLast7d'] as number | undefined;
    if (aMRC7d != null) console.log(`  Mid risk last 7d:   ${aMRC7d}`); // T922
    const aMRC30d = (a as Record<string, unknown>)['midRiskCountLast30d'] as number | undefined;
    if (aMRC30d != null) console.log(`  Mid risk last 30d:  ${aMRC30d}`); // T923
    const aMRC48 = (a as Record<string, unknown>)['midRiskCountLast48h'] as number | undefined;
    if (aMRC48 != null) console.log(`  Mid risk last 48h:  ${aMRC48}`); // T924
    const aMRC12 = (a as Record<string, unknown>)['midRiskCountLast12h'] as number | undefined;
    if (aMRC12 != null) console.log(`  Mid risk last 12h:  ${aMRC12}`); // T925
    const aOL6 = (a as Record<string, unknown>)['opsLast6h'] as number | undefined;
    if (aOL6 != null) console.log(`  Ops last 6h:        ${aOL6}`); // T926
    const aBL6 = (a as Record<string, unknown>)['blocksLast6h'] as number | undefined;
    if (aBL6 != null) console.log(`  Blocks last 6h:     ${aBL6}`); // T927
    const aAL6 = (a as Record<string, unknown>)['allowsLast6h'] as number | undefined;
    if (aAL6 != null) console.log(`  Allows last 6h:     ${aAL6}`); // T928
    const aBR6 = (a as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
    if (aBR6 != null) console.log(`  Block rate 6h:      ${(aBR6 * 100).toFixed(1)}%`); // T929
    const aAR6 = (a as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
    if (aAR6 != null) console.log(`  Allow rate 6h:      ${(aAR6 * 100).toFixed(1)}%`); // T930
    const aAPC6 = (a as Record<string, unknown>)['approvalCountLast6h'] as number | undefined;
    if (aAPC6 != null) console.log(`  Approvals last 6h:  ${aAPC6}`); // T931
    const aARL6_b = (a as Record<string, unknown>)['avgRiskLast6h'] as number | null | undefined;
    if (aARL6_b != null) console.log(`  Avg risk 6h:        ${aARL6_b.toFixed(3)}`); // T932
    const aHRC6 = (a as Record<string, unknown>)['highRiskCountLast6h'] as number | undefined;
    if (aHRC6 != null) console.log(`  High risk last 6h:  ${aHRC6}`); // T933
    const aLRC6 = (a as Record<string, unknown>)['lowRiskCountLast6h'] as number | undefined;
    if (aLRC6 != null) console.log(`  Low risk last 6h:   ${aLRC6}`); // T934
    const aMRC6 = (a as Record<string, unknown>)['midRiskCountLast6h'] as number | undefined;
    if (aMRC6 != null) console.log(`  Mid risk last 6h:   ${aMRC6}`); // T935
    const aRV6 = (a as Record<string, unknown>)['riskVolatilityLast6h'] as number | null | undefined;
    if (aRV6 != null) console.log(`  Risk volatility 6h: ${aRV6.toFixed(3)}`); // T936
    const aBSC_b = (a as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
    if (aBSC_b != null && aBSC_b > 0) console.log(`  Block streak:       ${aBSC_b}`); // T937
    const aASC_b = (a as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
    if (aASC_b != null && aASC_b > 0) console.log(`  Allow streak:       ${aASC_b}`); // T938
    const aAPSC = (a as Record<string, unknown>)['approvalStreakCurrent'] as number | undefined;
    if (aAPSC != null && aAPSC > 0) console.log(`  Approval streak:    ${aAPSC}`); // T939
    const aRV24 = (a as Record<string, unknown>)['riskVolatilityLast24h'] as number | null | undefined;
    if (aRV24 != null) console.log(`  Risk volatility 24h:${aRV24.toFixed(3)}`); // T940
    const aRV7d = (a as Record<string, unknown>)['riskVolatilityLast7d'] as number | null | undefined;
    if (aRV7d != null) console.log(`  Risk volatility 7d: ${aRV7d.toFixed(3)}`); // T941
    const aBRL6_b = (a as Record<string, unknown>)['blockRatioLast6h'] as number | null | undefined;
    if (aBRL6_b != null) console.log(`  Block ratio 6h:     ${(aBRL6_b * 100).toFixed(1)}%`); // T942
    const aBRL24_b = (a as Record<string, unknown>)['blockRatioLast24h'] as number | null | undefined;
    if (aBRL24_b != null) console.log(`  Block ratio 24h:    ${(aBRL24_b * 100).toFixed(1)}%`); // T943
    const aBRL7d = (a as Record<string, unknown>)['blockRatioLast7d'] as number | null | undefined;
    if (aBRL7d != null) console.log(`  Block ratio 7d:     ${(aBRL7d * 100).toFixed(1)}%`); // T944
    const aBRL30d = (a as Record<string, unknown>)['blockRatioLast30d'] as number | null | undefined;
    if (aBRL30d != null) console.log(`  Block ratio 30d:    ${(aBRL30d * 100).toFixed(1)}%`); // T945
    const aAIM24 = (a as Record<string, unknown>)['avgIntervalMsLast24h'] as number | null | undefined;
    if (aAIM24 != null) console.log(`  Avg interval 24h:   ${Math.round(aAIM24 / 1000)}s`); // T946
    const aAIM7d = (a as Record<string, unknown>)['avgIntervalMsLast7d'] as number | null | undefined;
    if (aAIM7d != null) console.log(`  Avg interval 7d:    ${Math.round(aAIM7d / 1000)}s`); // T947
    const aPHOD_b = (a as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
    if (aPHOD_b != null) console.log(`  Peak hour (UTC):    ${aPHOD_b}:00`); // T948
    const days7a = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const aPDOW = (a as Record<string, unknown>)['peakDayOfWeek'] as number | null | undefined;
    if (aPDOW != null) console.log(`  Peak day:           ${days7a[aPDOW]}`); // T949
    const aLADOW = (a as Record<string, unknown>)['leastActiveDayOfWeek'] as number | null | undefined;
    if (aLADOW != null) console.log(`  Least active day:   ${days7a[aLADOW]}`); // T950
    const aLAHOD = (a as Record<string, unknown>)['leastActiveHourOfDay'] as number | null | undefined;
    if (aLAHOD != null) console.log(`  Least active hour:  ${aLAHOD}:00`); // T951
    const aOL1_b = (a as Record<string, unknown>)['opsLast1h'] as number | undefined;
    if (aOL1_b != null) console.log(`  Ops last 1h:        ${aOL1_b}`); // T952
    const aBL1_b = (a as Record<string, unknown>)['blocksLast1h'] as number | undefined;
    if (aBL1_b != null) console.log(`  Blocks last 1h:     ${aBL1_b}`); // T953
    const aAL1 = (a as Record<string, unknown>)['allowsLast1h'] as number | undefined;
    if (aAL1 != null) console.log(`  Allows last 1h:     ${aAL1}`); // T954
    const aARL1 = (a as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (aARL1 != null) console.log(`  Avg risk 1h:        ${aARL1.toFixed(3)}`); // T955
    const aHRC1 = (a as Record<string, unknown>)['highRiskCountLast1h'] as number | undefined;
    if (aHRC1 != null) console.log(`  High risk last 1h:  ${aHRC1}`); // T956
    const aBR1 = (a as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (aBR1 != null) console.log(`  Block rate 1h:      ${(aBR1 * 100).toFixed(1)}%`); // T957
    const aAR1 = (a as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (aAR1 != null) console.log(`  Allow rate 1h:      ${(aAR1 * 100).toFixed(1)}%`); // T958
    const aAPR1 = (a as Record<string, unknown>)['approvalRateLast1h'] as number | null | undefined;
    if (aAPR1 != null) console.log(`  Approval rate 1h:   ${(aAPR1 * 100).toFixed(1)}%`); // T959
    const aRV1 = (a as Record<string, unknown>)['riskVolatilityLast1h'] as number | null | undefined;
    if (aRV1 != null) console.log(`  Risk volatility 1h: ${aRV1.toFixed(3)}`); // T960
    const aAPC1 = (a as Record<string, unknown>)['approvalCountLast1h'] as number | undefined;
    if (aAPC1 != null) console.log(`  Approvals last 1h:  ${aAPC1}`); // T961
    const aLRC1 = (a as Record<string, unknown>)['lowRiskCountLast1h'] as number | undefined;
    if (aLRC1 != null) console.log(`  Low risk last 1h:   ${aLRC1}`); // T962
    const aMRC1 = (a as Record<string, unknown>)['midRiskCountLast1h'] as number | undefined;
    if (aMRC1 != null) console.log(`  Mid risk last 1h:   ${aMRC1}`); // T963
    const aBRL1 = (a as Record<string, unknown>)['blockRatioLast1h'] as number | null | undefined;
    if (aBRL1 != null) console.log(`  Block ratio 1h:     ${(aBRL1 * 100).toFixed(1)}%`); // T964
    const aRWB24 = (a as Record<string, unknown>)['riskWeightedBlocksLast24h'] as number | null | undefined;
    if (aRWB24 != null) console.log(`  Risk-wtd blocks 24h:${aRWB24.toFixed(2)}`); // T965
    const aRWA24 = (a as Record<string, unknown>)['riskWeightedAllowsLast24h'] as number | null | undefined;
    if (aRWA24 != null) console.log(`  Risk-wtd allows 24h:${aRWA24.toFixed(2)}`); // T966
    const aRWB7 = (a as Record<string, unknown>)['riskWeightedBlocksLast7d'] as number | null | undefined;
    if (aRWB7 != null) console.log(`  Risk-wtd blocks 7d: ${aRWB7.toFixed(2)}`); // T967
    const aRWA7 = (a as Record<string, unknown>)['riskWeightedAllowsLast7d'] as number | null | undefined;
    if (aRWA7 != null) console.log(`  Risk-wtd allows 7d: ${aRWA7.toFixed(2)}`); // T968
    const aRWB30 = (a as Record<string, unknown>)['riskWeightedBlocksLast30d'] as number | null | undefined;
    if (aRWB30 != null) console.log(`  Risk-wtd blocks 30d:${aRWB30.toFixed(2)}`); // T969
    const aRWA30 = (a as Record<string, unknown>)['riskWeightedAllowsLast30d'] as number | null | undefined;
    if (aRWA30 != null) console.log(`  Risk-wtd allows 30d:${aRWA30.toFixed(2)}`); // T970
    const aNRW24 = (a as Record<string, unknown>)['netRiskWeightLast24h'] as number | undefined;
    if (aNRW24 != null) console.log(`  Net risk weight 24h:${aNRW24.toFixed(2)}`); // T971
    const aNRW7 = (a as Record<string, unknown>)['netRiskWeightLast7d'] as number | undefined;
    if (aNRW7 != null) console.log(`  Net risk weight 7d: ${aNRW7.toFixed(2)}`); // T972
    const aARWB24 = (a as Record<string, unknown>)['avgRiskWeightPerBlockLast24h'] as number | null | undefined;
    if (aARWB24 != null) console.log(`  Avg risk/block 24h: ${aARWB24.toFixed(3)}`); // T973
    const aARWA24 = (a as Record<string, unknown>)['avgRiskWeightPerAllowLast24h'] as number | null | undefined;
    if (aARWA24 != null) console.log(`  Avg risk/allow 24h: ${aARWA24.toFixed(3)}`); // T974
    const aARWB7 = (a as Record<string, unknown>)['avgRiskWeightPerBlockLast7d'] as number | null | undefined;
    if (aARWB7 != null) console.log(`  Avg risk/block 7d:  ${aARWB7.toFixed(3)}`); // T975
    const aARWA7 = (a as Record<string, unknown>)['avgRiskWeightPerAllowLast7d'] as number | null | undefined;
    if (aARWA7 != null) console.log(`  Avg risk/allow 7d:  ${aARWA7.toFixed(3)}`); // T976
    const aNRW30 = (a as Record<string, unknown>)['netRiskWeightLast30d'] as number | undefined;
    if (aNRW30 != null) console.log(`  Net risk weight 30d:${aNRW30.toFixed(2)}`); // T977
    const aARWB30 = (a as Record<string, unknown>)['avgRiskWeightPerBlockLast30d'] as number | null | undefined;
    if (aARWB30 != null) console.log(`  Avg risk/block 30d: ${aARWB30.toFixed(3)}`); // T978
    const aARWA30 = (a as Record<string, unknown>)['avgRiskWeightPerAllowLast30d'] as number | null | undefined;
    if (aARWA30 != null) console.log(`  Avg risk/allow 30d: ${aARWA30.toFixed(3)}`); // T979
    const aBAR24 = (a as Record<string, unknown>)['blockToAllowRatioLast24h'] as number | null | undefined;
    if (aBAR24 != null) console.log(`  Block:allow ratio 24h:${aBAR24.toFixed(2)}`); // T980
    const aBAR7 = (a as Record<string, unknown>)['blockToAllowRatioLast7d'] as number | null | undefined;
    if (aBAR7 != null) console.log(`  Block:allow ratio 7d: ${aBAR7.toFixed(2)}`); // T981
    const aBAR30 = (a as Record<string, unknown>)['blockToAllowRatioLast30d'] as number | null | undefined;
    if (aBAR30 != null) console.log(`  Block:allow ratio 30d:${aBAR30.toFixed(2)}`); // T982
    const aRSM24 = (a as Record<string, unknown>)['riskScoreMomentumLast24h'] as number | null | undefined;
    if (aRSM24 != null) console.log(`  Risk momentum 24h:  ${aRSM24 >= 0 ? '+' : ''}${aRSM24.toFixed(3)}`); // T983
    const aRSM7 = (a as Record<string, unknown>)['riskScoreMomentumLast7d'] as number | null | undefined;
    if (aRSM7 != null) console.log(`  Risk momentum 7d:   ${aRSM7 >= 0 ? '+' : ''}${aRSM7.toFixed(3)}`); // T984
    const aATBR24 = (a as Record<string, unknown>)['approvalToBlockRatioLast24h'] as number | null | undefined;
    if (aATBR24 != null) console.log(`  Approval:block 24h: ${aATBR24.toFixed(2)}`); // T985
    const aATBR7 = (a as Record<string, unknown>)['approvalToBlockRatioLast7d'] as number | null | undefined;
    if (aATBR7 != null) console.log(`  Approval:block 7d:  ${aATBR7.toFixed(2)}`); // T986
    const aOPH24 = (a as Record<string, unknown>)['opsPerHourLast24h'] as number | undefined;
    if (aOPH24 != null) console.log(`  Ops/hour last 24h:  ${aOPH24.toFixed(2)}`); // T987
    const aOPH7 = (a as Record<string, unknown>)['opsPerHourLast7d'] as number | undefined;
    if (aOPH7 != null) console.log(`  Ops/hour last 7d:   ${aOPH7.toFixed(2)}`); // T988
    const aOPH30 = (a as Record<string, unknown>)['opsPerHourLast30d'] as number | undefined;
    if (aOPH30 != null) console.log(`  Ops/hour last 30d:  ${aOPH30.toFixed(2)}`); // T989
    const aBPH24 = (a as Record<string, unknown>)['blocksPerHourLast24h'] as number | undefined;
    if (aBPH24 != null) console.log(`  Blocks/hr 24h:      ${aBPH24.toFixed(2)}`); // T990
    const aBPH7 = (a as Record<string, unknown>)['blocksPerHourLast7d'] as number | undefined;
    if (aBPH7 != null) console.log(`  Blocks/hr 7d:       ${aBPH7.toFixed(2)}`); // T991
    const aAPH24 = (a as Record<string, unknown>)['allowsPerHourLast24h'] as number | undefined;
    if (aAPH24 != null) console.log(`  Allows/hr 24h:      ${aAPH24.toFixed(2)}`); // T992
    const aAPH7 = (a as Record<string, unknown>)['allowsPerHourLast7d'] as number | undefined;
    if (aAPH7 != null) console.log(`  Allows/hr 7d:       ${aAPH7.toFixed(2)}`); // T993
    const aAPH30 = (a as Record<string, unknown>)['allowsPerHourLast30d'] as number | undefined;
    if (aAPH30 != null) console.log(`  Allows/hr 30d:      ${aAPH30.toFixed(2)}`); // T994
    const aBPH30 = (a as Record<string, unknown>)['blocksPerHourLast30d'] as number | undefined;
    if (aBPH30 != null) console.log(`  Blocks/hr 30d:      ${aBPH30.toFixed(2)}`); // T995
    const aHRPH24 = (a as Record<string, unknown>)['highRiskOpsPerHourLast24h'] as number | undefined;
    if (aHRPH24 != null) console.log(`  HiRisk ops/hr 24h:  ${aHRPH24.toFixed(2)}`); // T996
    const aHRPH7 = (a as Record<string, unknown>)['highRiskOpsPerHourLast7d'] as number | undefined;
    if (aHRPH7 != null) console.log(`  HiRisk ops/hr 7d:   ${aHRPH7.toFixed(2)}`); // T997
    const aUTC24 = (a as Record<string, unknown>)['uniqueToolsCountLast24h'] as number | undefined;
    if (aUTC24 != null) console.log(`  Unique tools 24h:   ${aUTC24}`); // T998
    const aUTC7 = (a as Record<string, unknown>)['uniqueToolsCountLast7d'] as number | undefined;
    if (aUTC7 != null) console.log(`  Unique tools 7d:    ${aUTC7}`); // T999
    const aUAC24 = (a as Record<string, unknown>)['uniqueAgentsCountLast24h'] as number | undefined;
    if (aUAC24 != null) console.log(`  Unique agents 24h:  ${aUAC24}`); // T1000
    const aUAC7 = (a as Record<string, unknown>)['uniqueAgentsCountLast7d'] as number | undefined;
    if (aUAC7 != null) console.log(`  Unique agents 7d:   ${aUAC7}`); // T1001
    const aMXR24 = (a as Record<string, unknown>)['maxRiskLast24h'] as number | null | undefined;
    if (aMXR24 != null) console.log(`  Max risk 24h:       ${aMXR24.toFixed(3)}`); // T1002
    const aMXR7 = (a as Record<string, unknown>)['maxRiskLast7d'] as number | null | undefined;
    if (aMXR7 != null) console.log(`  Max risk 7d:        ${aMXR7.toFixed(3)}`); // T1003
    const aMNR24 = (a as Record<string, unknown>)['minRiskLast24h'] as number | null | undefined;
    if (aMNR24 != null) console.log(`  Min risk 24h:       ${aMNR24.toFixed(3)}`); // T1004
    const aMNR7 = (a as Record<string, unknown>)['minRiskLast7d'] as number | null | undefined;
    if (aMNR7 != null) console.log(`  Min risk 7d:        ${aMNR7.toFixed(3)}`); // T1005
    const aMXR30 = (a as Record<string, unknown>)['maxRiskLast30d'] as number | null | undefined;
    if (aMXR30 != null) console.log(`  Max risk 30d:       ${aMXR30.toFixed(3)}`); // T1006
    const aMNR30 = (a as Record<string, unknown>)['minRiskLast30d'] as number | null | undefined;
    if (aMNR30 != null) console.log(`  Min risk 30d:       ${aMNR30.toFixed(3)}`); // T1007
    const aRRL24 = (a as Record<string, unknown>)['riskRangeLast24h'] as number | null | undefined;
    if (aRRL24 != null) console.log(`  Risk range 24h:     ${aRRL24.toFixed(3)}`); // T1008
    const aRRL7 = (a as Record<string, unknown>)['riskRangeLast7d'] as number | null | undefined;
    if (aRRL7 != null) console.log(`  Risk range 7d:      ${aRRL7.toFixed(3)}`); // T1009
    const aRRL30 = (a as Record<string, unknown>)['riskRangeLast30d'] as number | null | undefined;
    if (aRRL30 != null) console.log(`  Risk range 30d:     ${aRRL30.toFixed(3)}`); // T1010
    const aP25_b = (a as Record<string, unknown>)['p25Risk'] as number | null | undefined;
    if (aP25_b != null) console.log(`  P25 risk:           ${aP25_b.toFixed(3)}`); // T1011
    const aP75 = (a as Record<string, unknown>)['p75Risk'] as number | null | undefined;
    if (aP75 != null) console.log(`  P75 risk:           ${aP75.toFixed(3)}`); // T1012
    const aIQR_b = (a as Record<string, unknown>)['iqrRisk'] as number | null | undefined;
    if (aIQR_b != null) console.log(`  IQR risk:           ${aIQR_b.toFixed(3)}`); // T1013
    const aP95_b = (a as Record<string, unknown>)['p95Risk'] as number | null | undefined;
    if (aP95_b != null) console.log(`  P95 risk:           ${aP95_b.toFixed(3)}`); // T1014
    const aP5 = (a as Record<string, unknown>)['p5Risk'] as number | null | undefined;
    if (aP5 != null) console.log(`  P5 risk:            ${aP5.toFixed(3)}`); // T1015
    const aRSS = (a as Record<string, unknown>)['riskSkewnessSign'] as number | null | undefined;
    if (aRSS != null) console.log(`  Risk skewness sign: ${aRSS}`); // T1016
    const aAPR30 = (a as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
    if (aAPR30 != null) console.log(`  Approval rate 30d:  ${(aAPR30 * 100).toFixed(1)}%`); // T1017
    const aAPC30 = (a as Record<string, unknown>)['approvalCountLast30d'] as number | undefined;
    if (aAPC30 != null && aAPC30 > 0) console.log(`  Approvals 30d:      ${aAPC30}`); // T1018
    const aBC1h = (a as Record<string, unknown>)['blockCountLast1h'] as number | undefined;
    if (aBC1h != null && aBC1h > 0) console.log(`  Blocks last 1h:     ${aBC1h}`); // T1019
    const aAC1h = (a as Record<string, unknown>)['allowCountLast1h'] as number | undefined;
    if (aAC1h != null && aAC1h > 0) console.log(`  Allows last 1h:     ${aAC1h}`); // T1020
    const aAPC24_b = (a as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
    if (aAPC24_b != null && aAPC24_b > 0) console.log(`  Approvals 24h:      ${aAPC24_b}`); // T1021
    const aAPC7 = (a as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
    if (aAPC7 != null && aAPC7 > 0) console.log(`  Approvals 7d:       ${aAPC7}`); // T1022
    const aAPR24_b = (a as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
    if (aAPR24_b != null) console.log(`  Approval rate 24h:  ${(aAPR24_b * 100).toFixed(1)}%`); // T1023
    const aAPR7 = (a as Record<string, unknown>)['approvalRateLast7d'] as number | null | undefined;
    if (aAPR7 != null) console.log(`  Approval rate 7d:   ${(aAPR7 * 100).toFixed(1)}%`); // T1024
    const aBR1h = (a as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
    if (aBR1h != null) console.log(`  Block rate 1h:      ${(aBR1h * 100).toFixed(1)}%`); // T1025
    const aAR1h = (a as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
    if (aAR1h != null) console.log(`  Allow rate 1h:      ${(aAR1h * 100).toFixed(1)}%`); // T1026
    const aBR7 = (a as Record<string, unknown>)['blockRateLast7d'] as number | null | undefined;
    if (aBR7 != null) console.log(`  Block rate 7d:      ${(aBR7 * 100).toFixed(1)}%`); // T1027
    const aAR7 = (a as Record<string, unknown>)['allowRateLast7d'] as number | null | undefined;
    if (aAR7 != null) console.log(`  Allow rate 7d:      ${(aAR7 * 100).toFixed(1)}%`); // T1028
    const aBR30 = (a as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
    if (aBR30 != null) console.log(`  Block rate 30d:     ${(aBR30 * 100).toFixed(1)}%`); // T1029
    const aAR30 = (a as Record<string, unknown>)['allowRateLast30d'] as number | null | undefined;
    if (aAR30 != null) console.log(`  Allow rate 30d:     ${(aAR30 * 100).toFixed(1)}%`); // T1030
    const aOC1h = (a as Record<string, unknown>)['opCountLast1h'] as number | undefined;
    if (aOC1h != null && aOC1h > 0) console.log(`  Ops last 1h:        ${aOC1h}`); // T1031
    const aOC24 = (a as Record<string, unknown>)['opCountLast24h'] as number | undefined;
    if (aOC24 != null && aOC24 > 0) console.log(`  Ops last 24h:       ${aOC24}`); // T1032
    const aOC7 = (a as Record<string, unknown>)['opCountLast7d'] as number | undefined;
    if (aOC7 != null && aOC7 > 0) console.log(`  Ops last 7d:        ${aOC7}`); // T1033
    const aOC30 = (a as Record<string, unknown>)['opCountLast30d'] as number | undefined;
    if (aOC30 != null && aOC30 > 0) console.log(`  Ops last 30d:       ${aOC30}`); // T1034
    const aBC24 = (a as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
    if (aBC24 != null && aBC24 > 0) console.log(`  Blocks 24h:         ${aBC24}`); // T1035
    const aBC7 = (a as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
    if (aBC7 != null && aBC7 > 0) console.log(`  Blocks 7d:          ${aBC7}`); // T1036
    const aBC30 = (a as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
    if (aBC30 != null && aBC30 > 0) console.log(`  Blocks 30d:         ${aBC30}`); // T1037
    const aAC24 = (a as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
    if (aAC24 != null && aAC24 > 0) console.log(`  Allows 24h:         ${aAC24}`); // T1038
    const aAC7 = (a as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
    if (aAC7 != null && aAC7 > 0) console.log(`  Allows 7d:          ${aAC7}`); // T1039
    const aAC30 = (a as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
    if (aAC30 != null && aAC30 > 0) console.log(`  Allows 30d:         ${aAC30}`); // T1040
    const aHRC24_b = (a as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
    if (aHRC24_b != null && aHRC24_b > 0) console.log(`  High-risk 24h:      ${aHRC24_b}`); // T1041
    const aHRC7 = (a as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
    if (aHRC7 != null && aHRC7 > 0) console.log(`  High-risk 7d:       ${aHRC7}`); // T1042
    const aHRC30 = (a as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
    if (aHRC30 != null && aHRC30 > 0) console.log(`  High-risk 30d:      ${aHRC30}`); // T1043
    const aHRR24 = (a as Record<string, unknown>)['highRiskRateLast24h'] as number | null | undefined;
    if (aHRR24 != null) console.log(`  High-risk rate 24h: ${(aHRR24 * 100).toFixed(1)}%`); // T1044
    const aHRR7 = (a as Record<string, unknown>)['highRiskRateLast7d'] as number | null | undefined;
    if (aHRR7 != null) console.log(`  High-risk rate 7d:  ${(aHRR7 * 100).toFixed(1)}%`); // T1045
    const aHRR30 = (a as Record<string, unknown>)['highRiskRateLast30d'] as number | null | undefined;
    if (aHRR30 != null) console.log(`  High-risk rate 30d: ${(aHRR30 * 100).toFixed(1)}%`); // T1046
    const aLRC24_b = (a as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
    if (aLRC24_b != null && aLRC24_b > 0) console.log(`  Low-risk 24h:       ${aLRC24_b}`); // T1047
    const aLRC7 = (a as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
    if (aLRC7 != null && aLRC7 > 0) console.log(`  Low-risk 7d:        ${aLRC7}`); // T1048
    const aLRC30 = (a as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
    if (aLRC30 != null && aLRC30 > 0) console.log(`  Low-risk 30d:       ${aLRC30}`); // T1049
    const aLRR24 = (a as Record<string, unknown>)['lowRiskRateLast24h'] as number | null | undefined;
    if (aLRR24 != null) console.log(`  Low-risk rate 24h:  ${(aLRR24 * 100).toFixed(1)}%`); // T1050
    const aLRR7 = (a as Record<string, unknown>)['lowRiskRateLast7d'] as number | null | undefined;
    if (aLRR7 != null) console.log(`  Low-risk rate 7d:   ${(aLRR7 * 100).toFixed(1)}%`); // T1051
    const aLRR30 = (a as Record<string, unknown>)['lowRiskRateLast30d'] as number | null | undefined;
    if (aLRR30 != null) console.log(`  Low-risk rate 30d:  ${(aLRR30 * 100).toFixed(1)}%`); // T1052
    const aMRC24_b = (a as Record<string, unknown>)['medRiskCountLast24h'] as number | undefined;
    if (aMRC24_b != null && aMRC24_b > 0) console.log(`  Med-risk 24h:       ${aMRC24_b}`); // T1053
    const aMRC7 = (a as Record<string, unknown>)['medRiskCountLast7d'] as number | undefined;
    if (aMRC7 != null && aMRC7 > 0) console.log(`  Med-risk 7d:        ${aMRC7}`); // T1054
    const aMRC30 = (a as Record<string, unknown>)['medRiskCountLast30d'] as number | undefined;
    if (aMRC30 != null && aMRC30 > 0) console.log(`  Med-risk 30d:       ${aMRC30}`); // T1055
    const aMRR24 = (a as Record<string, unknown>)['medRiskRateLast24h'] as number | null | undefined;
    if (aMRR24 != null) console.log(`  Med-risk rate 24h:  ${(aMRR24 * 100).toFixed(1)}%`); // T1056
    const aMRR7 = (a as Record<string, unknown>)['medRiskRateLast7d'] as number | null | undefined;
    if (aMRR7 != null) console.log(`  Med-risk rate 7d:   ${(aMRR7 * 100).toFixed(1)}%`); // T1057
    const aMRR30 = (a as Record<string, unknown>)['medRiskRateLast30d'] as number | null | undefined;
    if (aMRR30 != null) console.log(`  Med-risk rate 30d:  ${(aMRR30 * 100).toFixed(1)}%`); // T1058
    const aRV24_b = (a as Record<string, unknown>)['riskVarianceLast24h'] as number | null | undefined;
    if (aRV24_b != null) console.log(`  Risk variance 24h:  ${aRV24_b.toFixed(4)}`); // T1059
    const aRV7 = (a as Record<string, unknown>)['riskVarianceLast7d'] as number | null | undefined;
    if (aRV7 != null) console.log(`  Risk variance 7d:   ${aRV7.toFixed(4)}`); // T1060
    const aRSD24 = (a as Record<string, unknown>)['riskStdDevLast24h'] as number | null | undefined;
    if (aRSD24 != null) console.log(`  Risk std dev 24h:   ${aRSD24.toFixed(3)}`); // T1061
    const aRSD7 = (a as Record<string, unknown>)['riskStdDevLast7d'] as number | null | undefined;
    if (aRSD7 != null) console.log(`  Risk std dev 7d:    ${aRSD7.toFixed(3)}`); // T1062
    const aRSD30 = (a as Record<string, unknown>)['riskStdDevLast30d'] as number | null | undefined;
    if (aRSD30 != null) console.log(`  Risk std dev 30d:   ${aRSD30.toFixed(3)}`); // T1063
    const aRVA30 = (a as Record<string, unknown>)['riskVarianceLast30d'] as number | null | undefined;
    if (aRVA30 != null) console.log(`  Risk variance 30d:  ${aRVA30.toFixed(4)}`); // T1064
    const aAR1h_b = (a as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
    if (aAR1h_b != null) console.log(`  Avg risk 1h:        ${aAR1h_b.toFixed(3)}`); // T1065
    const aAR24 = (a as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
    if (aAR24 != null) console.log(`  Avg risk 24h:       ${aAR24.toFixed(3)}`); // T1066
    const aAR7_b = (a as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
    if (aAR7_b != null) console.log(`  Avg risk 7d:        ${aAR7_b.toFixed(3)}`); // T1067
    const aAR30_b = (a as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
    if (aAR30_b != null) console.log(`  Avg risk 30d:       ${aAR30_b.toFixed(3)}`); // T1068
    const aART1h = (a as Record<string, unknown>)['avgRiskTrend1hVs24h'] as number | null | undefined;
    if (aART1h != null) console.log(`  Avg risk trend 1h>24h: ${aART1h.toFixed(3)}`); // T1069
    const aART24 = (a as Record<string, unknown>)['avgRiskTrend24hVs7d'] as number | null | undefined;
    if (aART24 != null) console.log(`  Avg risk trend 24h>7d: ${aART24.toFixed(3)}`); // T1070
    const aART7 = (a as Record<string, unknown>)['avgRiskTrend7dVs30d'] as number | null | undefined;
    if (aART7 != null) console.log(`  Avg risk trend 7d>30d: ${aART7.toFixed(3)}`); // T1071
    const aMXR_b = (a as Record<string, unknown>)['maxRiskAllTime'] as number | null | undefined;
    if (aMXR_b != null) console.log(`  Max risk all-time:     ${aMXR_b.toFixed(3)}`); // T1072
    const aMNR_b = (a as Record<string, unknown>)['minRiskAllTime'] as number | null | undefined;
    if (aMNR_b != null) console.log(`  Min risk all-time:     ${aMNR_b.toFixed(3)}`); // T1073
    const aOCT1 = (a as Record<string, unknown>)['opCountTrend1hVs24h'] as number | null | undefined;
    if (aOCT1 != null) console.log(`  Op count trend 1h>24h: ${aOCT1.toFixed(2)}`); // T1074
    const aOCT24 = (a as Record<string, unknown>)['opCountTrend24hVs7d'] as number | null | undefined;
    if (aOCT24 != null) console.log(`  Op count trend 24h>7d: ${aOCT24.toFixed(2)}`); // T1075
    const aBCT_b = (a as Record<string, unknown>)['blockCountTrend1hVs24h'] as number | null | undefined;
    if (aBCT_b != null) console.log(`  Block count trend 1h>24h: ${aBCT_b.toFixed(2)}`); // T1076
    const aACT_b = (a as Record<string, unknown>)['allowCountTrend1hVs24h'] as number | null | undefined;
    if (aACT_b != null) console.log(`  Allow count trend 1h>24h: ${aACT_b.toFixed(2)}`); // T1077
    const aAPCT = (a as Record<string, unknown>)['approvalCountTrend1hVs24h'] as number | null | undefined;
    if (aAPCT != null) console.log(`  Approval count trend 1h>24h: ${aAPCT.toFixed(2)}`); // T1078
    const aBCT24 = (a as Record<string, unknown>)['blockCountTrend24hVs7d'] as number | null | undefined;
    if (aBCT24 != null) console.log(`  Block count trend 24h>7d:  ${aBCT24.toFixed(2)}`); // T1079
    const aACT24 = (a as Record<string, unknown>)['allowCountTrend24hVs7d'] as number | null | undefined;
    if (aACT24 != null) console.log(`  Allow count trend 24h>7d:  ${aACT24.toFixed(2)}`); // T1080
    const aAPCT24 = (a as Record<string, unknown>)['approvalCountTrend24hVs7d'] as number | null | undefined;
    if (aAPCT24 != null) console.log(`  Approval count trend 24h>7d: ${aAPCT24.toFixed(2)}`); // T1081
    const aBCT7 = (a as Record<string, unknown>)['blockCountTrend7dVs30d'] as number | null | undefined;
    if (aBCT7 != null) console.log(`  Block count trend 7d>30d:  ${aBCT7.toFixed(2)}`); // T1082
    const aACT7 = (a as Record<string, unknown>)['allowCountTrend7dVs30d'] as number | null | undefined;
    if (aACT7 != null) console.log(`  Allow count trend 7d>30d:  ${aACT7.toFixed(2)}`); // T1083
    const aAPCT7 = (a as Record<string, unknown>)['approvalCountTrend7dVs30d'] as number | null | undefined;
    if (aAPCT7 != null) console.log(`  Approval count trend 7d>30d: ${aAPCT7.toFixed(2)}`); // T1084
    const aRRA = (a as Record<string, unknown>)['riskRangeAllTime'] as number | null | undefined;
    if (aRRA != null) console.log(`  Risk range all-time:   ${aRRA.toFixed(3)}`); // T1085
    const aRP25 = (a as Record<string, unknown>)['riskP25'] as number | null | undefined;
    if (aRP25 != null) console.log(`  Risk P25:              ${aRP25.toFixed(3)}`); // T1086
    const aRP75 = (a as Record<string, unknown>)['riskP75'] as number | null | undefined;
    if (aRP75 != null) console.log(`  Risk P75:              ${aRP75.toFixed(3)}`); // T1087
    const aRIQR_c = (a as Record<string, unknown>)['riskIQR'] as number | null | undefined;
    if (aRIQR_c != null) console.log(`  Risk IQR:              ${aRIQR_c.toFixed(3)}`); // T1088
    const aRP25h24 = (a as Record<string, unknown>)['riskP25Last24h'] as number | null | undefined;
    if (aRP25h24 != null) console.log(`  Risk P25 24h:          ${aRP25h24.toFixed(3)}`); // T1089
    const aRP75h24 = (a as Record<string, unknown>)['riskP75Last24h'] as number | null | undefined;
    if (aRP75h24 != null) console.log(`  Risk P75 24h:          ${aRP75h24.toFixed(3)}`); // T1090
    const aRIQRh24 = (a as Record<string, unknown>)['riskIQRLast24h'] as number | null | undefined;
    if (aRIQRh24 != null) console.log(`  Risk IQR 24h:          ${aRIQRh24.toFixed(3)}`); // T1091
    const aRP25d7 = (a as Record<string, unknown>)['riskP25Last7d'] as number | null | undefined;
    if (aRP25d7 != null) console.log(`  Risk P25 7d:           ${aRP25d7.toFixed(3)}`); // T1092
    const aRP75d7 = (a as Record<string, unknown>)['riskP75Last7d'] as number | null | undefined;
    if (aRP75d7 != null) console.log(`  Risk P75 7d:           ${aRP75d7.toFixed(3)}`); // T1093
    const aRIQRd7 = (a as Record<string, unknown>)['riskIQRLast7d'] as number | null | undefined;
    if (aRIQRd7 != null) console.log(`  Risk IQR 7d:           ${aRIQRd7.toFixed(3)}`); // T1094
    const aRP25d30 = (a as Record<string, unknown>)['riskP25Last30d'] as number | null | undefined;
    if (aRP25d30 != null) console.log(`  Risk P25 30d:          ${aRP25d30.toFixed(3)}`); // T1095
    const aRP75d30 = (a as Record<string, unknown>)['riskP75Last30d'] as number | null | undefined;
    if (aRP75d30 != null) console.log(`  Risk P75 30d:          ${aRP75d30.toFixed(3)}`); // T1096
    const aRIQRd30 = (a as Record<string, unknown>)['riskIQRLast30d'] as number | null | undefined;
    if (aRIQRd30 != null) console.log(`  Risk IQR 30d:          ${aRIQRd30.toFixed(3)}`); // T1097
    const aRP10 = (a as Record<string, unknown>)['riskP10'] as number | null | undefined;
    if (aRP10 != null) console.log(`  Risk P10:              ${aRP10.toFixed(3)}`); // T1098
    const aDOW = (a as Record<string, unknown>)['avgRiskByDayOfWeek'] as Array<number | null> | undefined;
    if (aDOW && aDOW.some(v => v !== null)) { // T648
      const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      const dowStr = aDOW.map((v, i) => `${days[i]}:${v !== null ? (v*100).toFixed(0)+'%' : '--'}`).join(' ');
      console.log(`  Risk by day:  ${dowStr}`);
    }
    const aCBD = (a as Record<string, unknown>)['operationsCountByDay'] as number[] | undefined;
    if (aCBD && aCBD.some(v => v > 0)) { // T650
      const max = Math.max(...aCBD, 1);
      const spark = aCBD.map(v => v === 0 ? '·' : v / max >= 0.7 ? '█' : v / max >= 0.4 ? '▄' : '▁').join('');
      console.log(`  Ops/day sparkline: ${spark} (today←6d ago)`);
    }
    return;
  }

  // T303: --limit/--offset pagination; T317: --q search flag; T331: --sort/--order; T386: --min-ops/--max-ops/--min-avg-risk/--max-avg-risk; T408: --method
  const agentListLimit      = parseFlag(args, 'limit');
  const agentListOffset     = parseFlag(args, 'offset');
  const agentListQ          = parseFlag(args, 'q');
  const agentListSort       = parseFlag(args, 'sort');
  const agentListOrder      = parseFlag(args, 'order');
  const agentListMinOps     = parseFlag(args, 'min-ops');
  const agentListMaxOps     = parseFlag(args, 'max-ops');
  const agentListMinAvgRisk = parseFlag(args, 'min-avg-risk');
  const agentListMaxAvgRisk = parseFlag(args, 'max-avg-risk');
  const agentListMethod     = parseFlag(args, 'method');       // T408
  const agentListParams = new URLSearchParams();
  if (agentListLimit)      agentListParams.set('limit', agentListLimit);
  if (agentListOffset)     agentListParams.set('offset', agentListOffset);
  if (agentListQ)          agentListParams.set('q', agentListQ);
  if (agentListSort)       agentListParams.set('sort', agentListSort);
  if (agentListOrder)      agentListParams.set('order', agentListOrder);
  if (agentListMinOps)     agentListParams.set('minOps', agentListMinOps);
  if (agentListMaxOps)     agentListParams.set('maxOps', agentListMaxOps);
  if (agentListMinAvgRisk) agentListParams.set('minAvgRiskScore', agentListMinAvgRisk);
  if (agentListMaxAvgRisk) agentListParams.set('maxAvgRiskScore', agentListMaxAvgRisk);
  if (agentListMethod)     agentListParams.set('method', agentListMethod);
  const agentListUrl = `/agents${agentListParams.toString() ? `?${agentListParams}` : ''}`;
  const { status, body } = await dashFetch(state.dashboardPort, 'GET', agentListUrl);
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }
  const b = body as { agents: Array<{ agentId: string; totalOps: number; avgRiskScore: number; blockRate?: number; lastSeen: string }>; count: number };
  if (b.count === 0) { console.log('No agents tracked yet.'); return; }
  console.log(`Agents (${b.count}):\n`);
  console.log('AGENT'.padEnd(28) + 'OPS'.padEnd(8) + 'AVG RISK'.padEnd(11) + 'BLK RATE   LAST SEEN'); // T504
  console.log('─'.repeat(80));
  for (const a of b.agents) {
    const ts = new Date(a.lastSeen).toLocaleString();
    const blkRate = a.blockRate !== undefined ? `${(a.blockRate * 100).toFixed(1)}%`.padEnd(11) : ''.padEnd(11); // T504
    console.log(`${a.agentId.slice(0,26).padEnd(28)}${String(a.totalOps).padEnd(8)}${(a.avgRiskScore * 100).toFixed(1).padEnd(11)}${blkRate}${ts}`);
  }
}
