import { readState, dashFetch } from './shared.js';

export async function cmdOpsSummary(_args: string[]): Promise<void> {
  const state = await readState();
  if (!state) { console.error('AgentsGate is not running.'); process.exit(1); }

  const { status, body } = await dashFetch(state.dashboardPort, 'GET', '/operations/summary');
  if (status !== 200) { console.error(`Dashboard returned ${status}`); process.exit(1); }

  type Summary = {
    totalOps: number;
    byAction: { allow: number; block: number; require_approval: number };
    avgRiskScore: number;
    minRiskScore?: number;
    maxRiskScore?: number;
    blockRate?: number;
    totalSessions?: number;
    uniqueAgents?: number;  // T447
    uniqueTools?: number;   // T447
    highRiskCount?: number;   // T447
    mediumRiskCount?: number; // T447
    lowRiskCount?: number;    // T447
    avgSessionSize?: number;  // T447
    avgRiskTrend?: string;   // T509
    blockTrend?: string;     // T509
    firstSeen?: string; // T418
    lastSeen?: string;  // T418
    topAgents: Array<{ agentId: string; count: number }>;
    topTools: Array<{ tool: string; count: number }>;
    topRiskAgents?: Array<{ agentId: string; avgRisk: number }>; // T510
    topRiskTools?: Array<{ tool: string; avgRisk: number }>;     // T510
  };
  const s = body as Summary;

  console.log(`Operations Summary`);
  console.log('─'.repeat(40));
  console.log(`  Total ops:    ${s.totalOps}`);
  console.log(`  Allow:        ${s.byAction.allow}`);
  console.log(`  Block:        ${s.byAction.block}`);
  console.log(`  Need approval:${s.byAction.require_approval}`);
  console.log(`  Avg risk:     ${(s.avgRiskScore * 100).toFixed(1)}%`);
  // T397: display minRiskScore/maxRiskScore if present
  if (s.minRiskScore !== undefined) console.log(`  Min risk:     ${(s.minRiskScore * 100).toFixed(1)}%`);
  if (s.maxRiskScore !== undefined) console.log(`  Max risk:     ${(s.maxRiskScore * 100).toFixed(1)}%`);
  // T321: display blockRate and totalSessions if present
  if (s.blockRate !== undefined) console.log(`  Block rate:   ${(s.blockRate * 100).toFixed(1)}%`);
  if (s.totalSessions !== undefined) console.log(`  Sessions:     ${s.totalSessions}`);
  // T447: display risk tier counts and unique counts
  if (s.uniqueAgents !== undefined) console.log(`  Unique agents: ${s.uniqueAgents}`);
  if (s.uniqueTools !== undefined)  console.log(`  Unique tools:  ${s.uniqueTools}`);
  if (s.highRiskCount !== undefined)   console.log(`  High risk (≥70%): ${s.highRiskCount}`);
  if (s.mediumRiskCount !== undefined) console.log(`  Med risk (30-70%): ${s.mediumRiskCount}`);
  if (s.lowRiskCount !== undefined)    console.log(`  Low risk (<30%):  ${s.lowRiskCount}`);
  if (s.avgSessionSize !== undefined)  console.log(`  Avg session size: ${s.avgSessionSize.toFixed(1)} ops`);
  if (s.avgRiskTrend) console.log(`  Risk trend:   ${s.avgRiskTrend}`); // T509
  if (s.blockTrend)   console.log(`  Block trend:  ${s.blockTrend}`);   // T509
  const sumR1h = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
  if (sumR1h !== undefined && sumR1h !== null) console.log(`  Avg risk (1h):  ${(sumR1h * 100).toFixed(1)}%`); // T561
  const sumR24h = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
  if (sumR24h !== undefined && sumR24h !== null) console.log(`  Avg risk (24h): ${(sumR24h * 100).toFixed(1)}%`); // T561
  const sumBk24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
  const sumBk1  = (s as Record<string, unknown>)['blockCountLast1h']  as number | undefined;
  const sumAl24 = (s as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
  const sumAl1  = (s as Record<string, unknown>)['allowCountLast1h']  as number | undefined;
  if (sumBk24 !== undefined) console.log(`  Blocks (24h):   ${sumBk24}`); // T565
  if (sumBk1  !== undefined) console.log(`  Blocks (1h):    ${sumBk1}`);  // T565
  if (sumAl24 !== undefined) console.log(`  Allows (24h):   ${sumAl24}`); // T565
  if (sumAl1  !== undefined) console.log(`  Allows (1h):    ${sumAl1}`);  // T565
  // T418: display firstSeen/lastSeen if present
  if (s.firstSeen) console.log(`  First seen:   ${s.firstSeen}`);
  if (s.lastSeen)  console.log(`  Last seen:    ${s.lastSeen}`);

  if (s.topAgents.length) {
    console.log(`\nTop Agents:`);
    for (const a of s.topAgents) console.log(`  ${a.agentId.padEnd(30)} ${a.count} ops`);
  }
  if (s.topTools.length) {
    console.log(`\nTop Tools:`);
    for (const t of s.topTools) console.log(`  ${t.tool.padEnd(30)} ${t.count} ops`);
  }
  if (s.topRiskAgents && s.topRiskAgents.length) { // T510
    console.log(`\nTop Risk Agents:`);
    for (const a of s.topRiskAgents) console.log(`  ${a.agentId.padEnd(30)} avg ${(a.avgRisk * 100).toFixed(1)}%`);
  }
  if (s.topRiskTools && s.topRiskTools.length) { // T510
    console.log(`\nTop Risk Tools:`);
    for (const t of s.topRiskTools) console.log(`  ${t.tool.padEnd(30)} avg ${(t.avgRisk * 100).toFixed(1)}%`);
  }
  const topRiskMethods = (s as Record<string, unknown>)['topRiskMethods'] as Array<{method: string; avgRisk: number}> | undefined;
  if (topRiskMethods && topRiskMethods.length) { // T575
    console.log(`\nTop Risk Methods:`);
    for (const m of topRiskMethods) console.log(`  ${m.method.padEnd(30)} avg ${(m.avgRisk * 100).toFixed(1)}%`);
  }
  const sumAR = (s as Record<string, unknown>)['avgAllowRisk'] as number | null | undefined;
  const sumBR = (s as Record<string, unknown>)['avgBlockRisk'] as number | null | undefined;
  if (sumAR !== undefined && sumAR !== null) console.log(`\n  Avg risk (allow): ${(sumAR * 100).toFixed(1)}%  (block): ${sumBR !== undefined && sumBR !== null ? (sumBR * 100).toFixed(1) + '%' : '—'}`); // T580
  const sumPR = (s as Record<string, unknown>)['avgPendingRisk'] as number | null | undefined;
  if (sumPR !== undefined && sumPR !== null) console.log(`  Avg risk (pending): ${(sumPR * 100).toFixed(1)}%`); // T591
  const sumSD = (s as Record<string, unknown>)['riskScoreStdDev'] as number | undefined;
  if (sumSD !== undefined && sumSD > 0) console.log(`  Risk std dev:       ${(sumSD * 100).toFixed(1)}%`); // T592
  const sumOR = (s as Record<string, unknown>)['operationRate'] as number | undefined;
  if (sumOR !== undefined) console.log(`  Op rate (24h):      ${sumOR.toFixed(3)} ops/min`); // T597
  const sumP25 = (s as Record<string, unknown>)['p25RiskScore'] as number | undefined;
  const sumIQR = (s as Record<string, unknown>)['interquartileRange'] as number | undefined;
  if (sumP25 !== undefined) console.log(`  p25 risk:           ${(sumP25 * 100).toFixed(1)}%${sumIQR !== undefined ? `  IQR: ${(sumIQR * 100).toFixed(1)}%` : ''}`); // T606
  const sumSkew = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
  if (sumSkew !== undefined && sumSkew !== null) console.log(`  Risk skewness:      ${sumSkew.toFixed(3)}`); // T612
  const sumConc = (s as Record<string, unknown>)['riskConcentration'] as number | null | undefined;
  if (sumConc !== undefined && sumConc !== null) console.log(`  Risk concentration: ${(sumConc * 100).toFixed(1)}% (top 20% ops)`); // T614
  const sumRV = (s as Record<string, unknown>)['riskVelocity'] as number | null | undefined;
  if (sumRV !== undefined && sumRV !== null) console.log(`  Risk velocity:      ${sumRV >= 0 ? '+' : ''}${(sumRV * 100).toFixed(2)}% (1h delta)`); // T618
  const sumBV = (s as Record<string, unknown>)['blockVelocity'] as number | null | undefined;
  if (sumBV !== undefined && sumBV !== null) console.log(`  Block velocity:     ${sumBV >= 0 ? '+' : ''}${sumBV} (1h delta)`); // T619
  const sumHourly = (s as Record<string, unknown>)['avgRiskByHour'] as Array<number | null> | undefined;
  if (sumHourly && sumHourly.some(v => v !== null)) { // T622
    const sparkline = sumHourly.slice(0, 12).map(v => v === null ? '·' : v >= 0.7 ? '█' : v >= 0.4 ? '▄' : '▁').join('');
    console.log(`  Risk/hr sparkline:  ${sparkline} (last 12h, newest left)`);
  }
  const sumTTrans = (s as Record<string, unknown>)['riskTierTransitions'] as number | undefined;
  if (sumTTrans !== undefined) console.log(`  Tier transitions:   ${sumTTrans}`); // T626
  const sumBARate = (s as Record<string, unknown>)['blockedAgentRate'] as number | null | undefined;
  if (sumBARate !== undefined && sumBARate !== null) console.log(`  Blocked agent rate: ${(sumBARate * 100).toFixed(1)}%`); // T627
  const sumBTRate = (s as Record<string, unknown>)['blockedToolRate'] as number | null | undefined;
  if (sumBTRate !== undefined && sumBTRate !== null) console.log(`  Blocked tool rate:  ${(sumBTRate * 100).toFixed(1)}%`); // T628
  const sumMBR = (s as Record<string, unknown>)['topMethodsByBlockRate'] as Array<{method: string; blockRate: number}> | undefined;
  if (sumMBR && sumMBR.length > 0) console.log(`  Top block methods:  ${sumMBR.slice(0,3).map(m => `${m.method}(${(m.blockRate*100).toFixed(0)}%)`).join(', ')}`); // T630
  const sumADI = (s as Record<string, unknown>)['agentDiversityIndex'] as number | null | undefined;
  if (sumADI !== undefined && sumADI !== null) console.log(`  Agent diversity:    ${sumADI.toFixed(3)} bits`); // T631
  const sumTDI = (s as Record<string, unknown>)['toolDiversityIndex'] as number | null | undefined;
  if (sumTDI !== undefined && sumTDI !== null) console.log(`  Tool diversity:     ${sumTDI.toFixed(3)} bits`); // T632
  const sumSDI = (s as Record<string, unknown>)['sessionDiversityIndex'] as number | null | undefined;
  if (sumSDI !== undefined && sumSDI !== null) console.log(`  Session diversity:  ${sumSDI.toFixed(3)} bits`); // T633
  const sumOPA = (s as Record<string, unknown>)['avgOpsPerAgent'] as number | null | undefined;
  const sumOPT = (s as Record<string, unknown>)['avgOpsPerTool'] as number | null | undefined;
  if (sumOPA !== undefined && sumOPA !== null) console.log(`  Avg ops/agent:      ${sumOPA.toFixed(1)}${sumOPT !== undefined && sumOPT !== null ? `  Avg ops/tool: ${sumOPT.toFixed(1)}` : ''}`); // T634/T635
  const sumHRR = (s as Record<string, unknown>)['highRiskRate'] as number | undefined;
  const sumMRR = (s as Record<string, unknown>)['mediumRiskRate'] as number | undefined;
  const sumLRR = (s as Record<string, unknown>)['lowRiskRate'] as number | undefined;
  if (sumHRR !== undefined) console.log(`  Risk tiers:         H:${(sumHRR*100).toFixed(1)}%${sumMRR!==undefined?` M:${(sumMRR*100).toFixed(1)}%`:''}${sumLRR!==undefined?` L:${(sumLRR*100).toFixed(1)}%`:''}`); // T636-T639
  const sumBRH = (s as Record<string, unknown>)['blockRateByHour'] as Array<number | null> | undefined;
  if (sumBRH && sumBRH.some(v => v !== null)) { // T637
    const brSpark = sumBRH.slice(0, 12).map(v => v === null ? '·' : v >= 0.5 ? '█' : v >= 0.2 ? '▄' : '▁').join('');
    console.log(`  Block rate/hr:      ${brSpark} (last 12h, newest left)`);
  }
  const sumARH = (s as Record<string, unknown>)['allowRateByHour'] as Array<number | null> | undefined;
  if (sumARH && sumARH.some(v => v !== null)) { // T640
    const arSpark = sumARH.slice(0, 12).map(v => v === null ? '·' : v >= 0.8 ? '█' : v >= 0.5 ? '▄' : '▁').join('');
    console.log(`  Allow rate/hr:      ${arSpark} (last 12h, newest left)`);
  }
  const sumSBC = (s as Record<string, unknown>)['topSessionsByBlockCount'] as Array<{sessionId: string; blocked: number}> | undefined;
  if (sumSBC && sumSBC.length > 0) console.log(`  Top blocked sessions: ${sumSBC.slice(0,3).map(s => `${s.sessionId.slice(0,12)}(${s.blocked})`).join(', ')}`); // T643
  const sumDOW = (s as Record<string, unknown>)['avgRiskByDayOfWeek'] as Array<number | null> | undefined;
  if (sumDOW && sumDOW.some(v => v !== null)) { // T644
    const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const dowStr = sumDOW.map((v, i) => v !== null ? `${days[i]}:${(v*100).toFixed(0)}%` : null).filter(Boolean).join(' ');
    console.log(`  Risk by day:        ${dowStr}`);
  }
  const sumATHR = (s as Record<string, unknown>)['topAgentsByHighRiskOps'] as Array<{agentId: string; highRiskOps: number}> | undefined;
  if (sumATHR && sumATHR.length > 0) console.log(`  Top high-risk agents: ${sumATHR.slice(0,3).map(a => `${a.agentId.slice(0,12)}(${a.highRiskOps})`).join(', ')}`); // T645
  const sumTTHR = (s as Record<string, unknown>)['topToolsByHighRiskOps'] as Array<{tool: string; highRiskOps: number}> | undefined;
  if (sumTTHR && sumTTHR.length > 0) console.log(`  Top high-risk tools:  ${sumTTHR.slice(0,3).map(t => `${t.tool}(${t.highRiskOps})`).join(', ')}`); // T646
  const sumCBD = (s as Record<string, unknown>)['operationsCountByDay'] as number[] | undefined;
  if (sumCBD && sumCBD.some(v => v > 0)) { // T647
    const cbdSpark = sumCBD.map(v => v === 0 ? '·' : v >= 100 ? '█' : v >= 20 ? '▄' : '▁').join('');
    console.log(`  Ops/day (7d):       ${cbdSpark} (today left)`);
  }
  const sumCBR = (s as Record<string, unknown>)['consecutiveBlockRatio'] as number | undefined;
  if (sumCBR !== undefined && sumCBR > 0) console.log(`  Consec block ratio: ${(sumCBR * 100).toFixed(1)}% ops in block runs ≥2`); // T654
  const sumRA = (s as Record<string, unknown>)['riskAcceleration'] as number | null | undefined;
  if (sumRA !== null && sumRA !== undefined) console.log(`  Risk acceleration:  ${sumRA >= 0 ? '+' : ''}${(sumRA * 100).toFixed(1)}% (30m trend)`); // T655
  const sumTSR = (s as Record<string, unknown>)['toolSwitchRate'] as number | null | undefined;
  if (sumTSR !== null && sumTSR !== undefined) console.log(`  Tool switch rate:   ${(sumTSR * 100).toFixed(1)}% of consecutive op pairs`); // T656
  const sumPOPM = (s as Record<string, unknown>)['peakOpsPerMinute'] as number | undefined;
  if (sumPOPM !== undefined && sumPOPM > 0) console.log(`  Peak ops/min:       ${sumPOPM.toFixed(2)} (max over any 5-min window)`); // T657
  const sumACS = (s as Record<string, unknown>)['agentCoopScore'] as number | null | undefined;
  if (sumACS !== null && sumACS !== undefined) console.log(`  Agent coop score:   ${(sumACS * 100).toFixed(1)}% sessions w/ ≥2 agents`); // T658
  const sumMSR = (s as Record<string, unknown>)['methodSwitchRate'] as number | null | undefined;
  if (sumMSR !== null && sumMSR !== undefined) console.log(`  Method switch rate: ${(sumMSR * 100).toFixed(1)}% of consecutive op pairs`); // T663
  const sumRAS = (s as Record<string, unknown>)['riskAnomalyScore'] as number | null | undefined;
  if (sumRAS !== null && sumRAS !== undefined) console.log(`  Risk anomaly (z):   ${sumRAS >= 0 ? '+' : ''}${sumRAS.toFixed(2)} (last op vs mean)`); // T664
  const sumBRL = (s as Record<string, unknown>)['blockRunLengths'] as Record<string, number> | undefined;
  if (sumBRL && Object.values(sumBRL).some(v => v > 0)) { // T665
    const parts = Object.entries(sumBRL).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`  Block run lengths:  ${parts}`);
  }
  const sumATBO = (s as Record<string, unknown>)['avgTimeBetweenOps'] as number | null | undefined;
  if (sumATBO !== null && sumATBO !== undefined) console.log(`  Avg time bet. ops:  ${(sumATBO / 1000).toFixed(1)}s`); // T666
  const sumIR = (s as Record<string, unknown>)['idleRatio'] as number | undefined;
  if (sumIR !== undefined) console.log(`  Idle ratio (24h):   ${(sumIR * 100).toFixed(0)}% of hours idle`); // T668
  const sumRP = (s as Record<string, unknown>)['riskProfile'] as string | undefined;
  if (sumRP) console.log(`  Risk profile:       ${sumRP.toUpperCase()}`); // T669
  const sumBBS = (s as Record<string, unknown>)['blockBurstScore'] as number | undefined;
  if (sumBBS !== undefined && sumBBS > 0) console.log(`  Block burst score:  ${(sumBBS * 100).toFixed(1)}% ops in bursts ≥3`); // T670
  const sumPS = (s as Record<string, unknown>)['pendingStreak'] as number | undefined;
  if (sumPS !== undefined && sumPS > 0) console.log(`  Pending streak:     ${sumPS} consecutive pending ops`); // T671
  const sumTBM = (s as Record<string, unknown>)['topBlockedMethods'] as Array<{method: string; blocked: number}> | undefined;
  if (sumTBM && sumTBM.length > 0) console.log(`  Top blocked methods: ${sumTBM.slice(0,3).map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T672
  const sumRSC = (s as Record<string, unknown>)['riskSkewnessCategory'] as string | null | undefined;
  if (sumRSC) console.log(`  Risk skew:          ${sumRSC}`); // T673
  const sumHRMC = (s as Record<string, unknown>)['highRiskMethodCount'] as number | undefined;
  if (sumHRMC !== undefined && sumHRMC > 0) console.log(`  High-risk methods:  ${sumHRMC} methods with avgRisk ≥70%`); // T678
  const sumSBC_b = (s as Record<string, unknown>)['sessionBurstCount'] as number | undefined;
  if (sumSBC_b !== undefined && sumSBC_b > 0) console.log(`  Session bursts:     ${sumSBC_b} sessions with block burst`); // T677
  const sumOBS = (s as Record<string, unknown>)['opsBySeverity'] as {critical: number; high: number; medium: number; low: number} | undefined;
  if (sumOBS) console.log(`  Ops by severity:    crit=${sumOBS.critical} high=${sumOBS.high} med=${sumOBS.medium} low=${sumOBS.low}`); // T676
  const sumRTS = (s as Record<string, unknown>)['riskTrendSlope'] as number | null | undefined;
  if (sumRTS !== null && sumRTS !== undefined) console.log(`  Risk trend slope:   ${sumRTS >= 0 ? '+' : ''}${sumRTS.toFixed(4)} per op`); // T679
  const sumARL30 = (s as Record<string, unknown>)['avgRiskLast30m'] as number | null | undefined;
  if (sumARL30 !== null && sumARL30 !== undefined) console.log(`  Avg risk (30m):     ${(sumARL30 * 100).toFixed(1)}%`); // T680
  const sumOL30 = (s as Record<string, unknown>)['opsLast30m'] as number | undefined;
  if (sumOL30 !== undefined) console.log(`  Ops last 30m:       ${sumOL30}`); // T683
  const sumBRL30 = (s as Record<string, unknown>)['blockRateLast30m'] as number | null | undefined;
  if (sumBRL30 !== null && sumBRL30 !== undefined) console.log(`  Block rate (30m):   ${(sumBRL30 * 100).toFixed(1)}%`); // T682
  const sumRBM = (s as Record<string, unknown>)['recentBlockedMethods'] as Array<{method: string; blocked: number}> | undefined;
  if (sumRBM && sumRBM.length > 0) console.log(`  Recent blk methods: ${sumRBM.map(m => `${m.method}(${m.blocked})`).join(', ')}`); // T681
  const sumTABR = (s as Record<string, unknown>)['topAgentsByBlockRate'] as Array<{agentId: string; blockRate: number}> | undefined;
  if (sumTABR && sumTABR.length > 0) console.log(`  Top block-rate agents: ${sumTABR.slice(0,3).map(a => `${a.agentId.slice(0,12)}(${(a.blockRate*100).toFixed(0)}%)`).join(', ')}`); // T684
  const sumTTBR = (s as Record<string, unknown>)['topToolsByBlockRate'] as Array<{tool: string; blockRate: number}> | undefined;
  if (sumTTBR && sumTTBR.length > 0) console.log(`  Top block-rate tools:  ${sumTTBR.slice(0,3).map(t => `${t.tool}(${(t.blockRate*100).toFixed(0)}%)`).join(', ')}`); // T685
  const sumBS = (s as Record<string, unknown>)['blockStreak'] as number | undefined;
  if (sumBS !== undefined && sumBS > 0) console.log(`  Block streak:       ${sumBS} consecutive blocks`); // T688
  const sumAS = (s as Record<string, unknown>)['allowStreak'] as number | undefined;
  if (sumAS !== undefined && sumAS > 0) console.log(`  Allow streak:       ${sumAS} consecutive allows`); // T688
  const sumMRS = (s as Record<string, unknown>)['maxRiskStreak'] as number | undefined;
  if (sumMRS !== undefined && sumMRS > 0) console.log(`  Max risk streak:    ${sumMRS} consecutive high-risk ops`); // T690
  const sumP99 = (s as Record<string, unknown>)['p99RiskScore'] as number | undefined;
  if (sumP99 !== undefined) console.log(`  p99 risk:           ${(sumP99 * 100).toFixed(1)}%`); // T691
  const sumROL5 = (s as Record<string, unknown>)['recentOpsLast5m'] as number | undefined;
  if (sumROL5 !== undefined) console.log(`  Ops last 5m:        ${sumROL5}`); // T692
  const sumTSAR = (s as Record<string, unknown>)['topSessionsByAvgRisk'] as Array<{sessionId: string; avgRisk: number}> | undefined;
  if (sumTSAR && sumTSAR.length > 0) console.log(`  Top sessions (risk): ${sumTSAR.slice(0,3).map(s => `${s.sessionId.slice(0,12)}(${(s.avgRisk*100).toFixed(0)}%)`).join(', ')}`); // T693
  const sumAL = (s as Record<string, unknown>)['alertLevel'] as string | undefined;
  if (sumAL) console.log(`  Alert level:        ${sumAL.toUpperCase()}`); // T694
  const sumBRC = (s as Record<string, unknown>)['blockRateChange'] as number | null | undefined;
  if (sumBRC != null) console.log(`  Block rate change:  ${sumBRC >= 0 ? '+' : ''}${(sumBRC * 100).toFixed(1)}%`); // T695
  const sumARC = (s as Record<string, unknown>)['avgRiskChange'] as number | null | undefined;
  if (sumARC != null) console.log(`  Avg risk change:    ${sumARC >= 0 ? '+' : ''}${(sumARC * 100).toFixed(1)}%`); // T696
  const sumFHBR = (s as Record<string, unknown>)['firstHalfBlockRate'] as number | null | undefined;
  const sumSHBR = (s as Record<string, unknown>)['secondHalfBlockRate'] as number | null | undefined;
  if (sumFHBR != null && sumSHBR != null) console.log(`  Block rate halves:  ${(sumFHBR*100).toFixed(1)}% → ${(sumSHBR*100).toFixed(1)}%`); // T697
  const sumTRWS = (s as Record<string, unknown>)['topRiskWindowStart'] as string | null | undefined;
  if (sumTRWS) console.log(`  Peak risk window:   ${new Date(sumTRWS).toLocaleTimeString()}`); // T698
  const sumOT24 = (s as Record<string, unknown>)['opsTrend24h'] as number[] | undefined;
  if (sumOT24) console.log(`  Ops last 24h:       ${sumOT24.reduce((a, b) => a + b, 0)} (peak/h: ${Math.max(...sumOT24)})`); // T699
  const sumBT24 = (s as Record<string, unknown>)['blockTrend24h'] as number[] | undefined;
  if (sumBT24) console.log(`  Blocks last 24h:    ${sumBT24.reduce((a, b) => a + b, 0)}`); // T700
  const sumRT24 = (s as Record<string, unknown>)['avgRiskTrend24h'] as Array<number | null> | undefined;
  if (sumRT24) { const vals = sumRT24.filter((v): v is number => v !== null); if (vals.length > 0) console.log(`  Avg risk 24h:       ${(vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1)}%`); } // T701
  const sumMD = (s as Record<string, unknown>)['methodDiversity'] as number | undefined;
  if (sumMD !== undefined) console.log(`  Method diversity:   ${sumMD.toFixed(3)}`); // T702
  const sumSD2 = (s as Record<string, unknown>)['sessionDiversity'] as number | undefined;
  if (sumSD2 !== undefined) console.log(`  Session diversity:  ${sumSD2.toFixed(3)}`); // T703
  const sumHRH = (s as Record<string, unknown>)['highRiskHourCount'] as number | undefined;
  if (sumHRH !== undefined && sumHRH > 0) console.log(`  High-risk hours:    ${sumHRH}/24`); // T704
  const sumZOH = (s as Record<string, unknown>)['zeroOpsHourCount'] as number | undefined;
  if (sumZOH !== undefined) console.log(`  Zero-ops hours:     ${sumZOH}/24`); // T705
  const sumBSH = (s as Record<string, unknown>)['blockSpikeHour'] as number | null | undefined;
  if (sumBSH != null) console.log(`  Block spike hour:   ${sumBSH} hrs ago`); // T706
  const sumOSH = (s as Record<string, unknown>)['opsSpikeHour'] as number | null | undefined;
  if (sumOSH != null) console.log(`  Ops spike hour:     ${sumOSH} hrs ago`); // T707
  const sumRV_b = (s as Record<string, unknown>)['riskVolatility'] as number | null | undefined;
  if (sumRV_b != null) console.log(`  Risk volatility:    ${(sumRV_b * 100).toFixed(1)}%`); // T708
  const sumCOC = (s as Record<string, unknown>)['criticalOpsCount'] as number | undefined;
  if (sumCOC !== undefined && sumCOC > 0) console.log(`  Critical ops (≥0.9): ${sumCOC}`); // T709
  const sumARBA = (s as Record<string, unknown>)['avgRiskByAction'] as Record<string, number> | undefined;
  if (sumARBA) console.log(`  Avg risk by action: allow=${(sumARBA['allow']!*100).toFixed(0)}% block=${(sumARBA['block']!*100).toFixed(0)}% pending=${(sumARBA['require_approval']!*100).toFixed(0)}%`); // T710
  const sumRAI = (s as Record<string, unknown>)['recentAgentIds'] as string[] | undefined;
  if (sumRAI && sumRAI.length > 0) console.log(`  Recent agents:      ${sumRAI.slice(0,3).join(', ')}`); // T711
  const sumRSI = (s as Record<string, unknown>)['recentSessionIds'] as string[] | undefined;
  if (sumRSI && sumRSI.length > 0) console.log(`  Recent sessions:    ${sumRSI.slice(0,3).map(s => s.slice(0,12)).join(', ')}`); // T712
  const sumOD = (s as Record<string, unknown>)['opsDensity'] as number | null | undefined;
  if (sumOD != null) console.log(`  Ops density:        ${sumOD.toFixed(1)}/h`); // T713
  const sumBFS = (s as Record<string, unknown>)['blockFreeStreak'] as number | undefined;
  if (sumBFS != null && sumBFS > 0) console.log(`  Block-free streak:  ${sumBFS} ops`); // T714
  const sumHRFS = (s as Record<string, unknown>)['highRiskFreeStreak'] as number | undefined;
  if (sumHRFS != null && sumHRFS > 0) console.log(`  Low-risk streak:    ${sumHRFS} ops`); // T715
  const sumAOBB = (s as Record<string, unknown>)['avgOpsBetweenBlocks'] as number | null | undefined;
  if (sumAOBB != null) console.log(`  Avg ops/block gap:  ${sumAOBB.toFixed(1)}`); // T716
  const sumRRT = (s as Record<string, unknown>)['recentRiskTrend'] as string | undefined;
  if (sumRRT) console.log(`  Recent risk trend:  ${sumRRT}`); // T717
  const sumCS = (s as Record<string, unknown>)['coverageScore'] as number | undefined;
  if (sumCS != null) console.log(`  24h coverage:       ${(sumCS * 100).toFixed(0)}%`); // T718
  const sumPHOD = (s as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
  if (sumPHOD != null) console.log(`  Peak hour:          h-${sumPHOD}`); // T719
  const sumQHOD = (s as Record<string, unknown>)['quietHourOfDay'] as number | null | undefined;
  if (sumQHOD != null) console.log(`  Quiet hour:         h-${sumQHOD}`); // T720
  const sumBRL_b = (s as Record<string, unknown>)['blockRunLengthMax'] as number | undefined;
  if (sumBRL_b != null && sumBRL_b > 0) console.log(`  Max block run:      ${sumBRL_b}`); // T721
  const sumARL = (s as Record<string, unknown>)['allowRunLengthMax'] as number | undefined;
  if (sumARL != null && sumARL > 0) console.log(`  Max allow run:      ${sumARL}`); // T722
  const sumRIQR = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
  if (sumRIQR != null) console.log(`  Risk IQR:           ${sumRIQR.toFixed(3)}`); // T723
  const sumMR = (s as Record<string, unknown>)['medianRisk'] as number | null | undefined;
  if (sumMR != null) console.log(`  Median risk:        ${sumMR.toFixed(3)}`); // T724
  const sumP90 = (s as Record<string, unknown>)['p90Risk'] as number | null | undefined;
  if (sumP90 != null) console.log(`  P90 risk:           ${sumP90.toFixed(3)}`); // T725
  const sumBRLH = (s as Record<string, unknown>)['blockRateLastHour'] as number | null | undefined;
  if (sumBRLH != null) console.log(`  Block rate (1h):    ${(sumBRLH * 100).toFixed(1)}%`); // T726
  const sumARLH = (s as Record<string, unknown>)['approvalRateLastHour'] as number | null | undefined;
  if (sumARLH != null) console.log(`  Approval rate (1h): ${(sumARLH * 100).toFixed(1)}%`); // T727
  const sumUTC = (s as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
  if (sumUTC != null) console.log(`  Unique tools:       ${sumUTC}`); // T728
  const sumRSD = (s as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
  if (sumRSD != null) console.log(`  Risk std dev:       ${sumRSD.toFixed(3)}`); // T729
  const sumFOT = (s as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
  if (sumFOT) console.log(`  First op:           ${sumFOT}`); // T730
  const sumLOT = (s as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
  if (sumLOT) console.log(`  Last op:            ${sumLOT}`); // T731
  const sumTBT = (s as Record<string, unknown>)['topBlockedTool'] as string | null | undefined;
  if (sumTBT) console.log(`  Top blocked tool:   ${sumTBT}`); // T732
  const sumARL10 = (s as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
  if (sumARL10 != null) console.log(`  Avg risk (last 10): ${sumARL10.toFixed(3)}`); // T733
  const sumBRLD = (s as Record<string, unknown>)['blockRateLastDay'] as number | null | undefined;
  if (sumBRLD != null) console.log(`  Block rate (24h):   ${(sumBRLD * 100).toFixed(1)}%`); // T734
  const sumTAT = (s as Record<string, unknown>)['topAllowedTool'] as string | null | undefined;
  if (sumTAT) console.log(`  Top allowed tool:   ${sumTAT}`); // T735
  const sumRBOI = (s as Record<string, unknown>)['recentBlockedOpIds'] as string[] | undefined;
  if (sumRBOI && sumRBOI.length > 0) console.log(`  Recent blocked ops: ${sumRBOI.map(id => id.slice(0,8)).join(', ')}`); // T736
  const sumRAOI = (s as Record<string, unknown>)['recentApprovedOpIds'] as string[] | undefined;
  if (sumRAOI && sumRAOI.length > 0) console.log(`  Recent pending ops: ${sumRAOI.map(id => id.slice(0,8)).join(', ')}`); // T737
  const sumSC = (s as Record<string, unknown>)['sessionCount'] as number | undefined;
  if (sumSC != null) console.log(`  Distinct sessions:  ${sumSC}`); // T738
  const sumMinR = (s as Record<string, unknown>)['minRisk'] as number | null | undefined;
  if (sumMinR != null) console.log(`  Min risk:           ${sumMinR.toFixed(3)}`); // T739
  const sumMaxR = (s as Record<string, unknown>)['maxRisk'] as number | null | undefined;
  if (sumMaxR != null) console.log(`  Max risk:           ${sumMaxR.toFixed(3)}`); // T740
  const sumARF10 = (s as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
  if (sumARF10 != null) console.log(`  Avg risk (first 10):${sumARF10.toFixed(3)}`); // T741
  const sumRDFL = (s as Record<string, unknown>)['riskDeltaFirstLast'] as number | null | undefined;
  if (sumRDFL != null) console.log(`  Risk delta F→L:     ${sumRDFL >= 0 ? '+' : ''}${sumRDFL.toFixed(3)}`); // T742
  const sumAM = (s as Record<string, unknown>)['activeMinutes'] as number | null | undefined;
  if (sumAM != null) console.log(`  Active span:        ${sumAM.toFixed(1)}m`); // T743
  const sumRSkew = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
  if (sumRSkew != null) console.log(`  Risk skewness:      ${sumRSkew.toFixed(3)}`); // T744
  const sumOB5 = (s as Record<string, unknown>)['opsBurst5m'] as number | undefined;
  if (sumOB5 != null) console.log(`  Ops burst (5m):     ${sumOB5}`); // T745
  const sumBB5 = (s as Record<string, unknown>)['blockBurst5m'] as number | undefined;
  if (sumBB5 != null && sumBB5 > 0) console.log(`  Block burst (5m):   ${sumBB5}`); // T746
  const sumAIMs = (s as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
  if (sumAIMs != null) console.log(`  Avg interval:       ${(sumAIMs/1000).toFixed(1)}s`); // T747
  const sumLGMs = (s as Record<string, unknown>)['longestGapMs'] as number | null | undefined;
  if (sumLGMs != null) console.log(`  Longest gap:        ${(sumLGMs/1000).toFixed(1)}s`); // T748
  const sumKurt = (s as Record<string, unknown>)['kurtosis'] as number | null | undefined;
  if (sumKurt != null) console.log(`  Kurtosis:           ${sumKurt.toFixed(3)}`); // T749
  const sumCHRM = (s as Record<string, unknown>)['consecutiveHighRiskMax'] as number | undefined;
  if (sumCHRM != null && sumCHRM > 0) console.log(`  Max hi-risk streak: ${sumCHRM}`); // T753
  const sumCLRM = (s as Record<string, unknown>)['consecutiveLowRiskMax'] as number | undefined;
  if (sumCLRM != null && sumCLRM > 0) console.log(`  Max lo-risk streak: ${sumCLRM}`); // T751
  const sumRBF = (s as Record<string, unknown>)['riskBucketsFine'] as number[] | undefined;
  if (sumRBF && sumRBF.some(v => v > 0)) console.log(`  Risk buckets(fine): ${sumRBF.join('|')}`); // T752
  const sumRWBR = (s as Record<string, unknown>)['riskWeightedBlockRate'] as number | null | undefined;
  if (sumRWBR != null) console.log(`  Risk-wtd blk rate:  ${(sumRWBR*100).toFixed(1)}%`); // T754
  const sumAPC = (s as Record<string, unknown>)['approvalPendingCount'] as number | undefined;
  if (sumAPC != null && sumAPC > 0) console.log(`  Pending approvals:  ${sumAPC}`); // T755
  const sumTMBO = (s as Record<string, unknown>)['topMethodByOps'] as string | null | undefined;
  if (sumTMBO) console.log(`  Top method (ops):   ${sumTMBO}`); // T756
  const sumTMBR = (s as Record<string, unknown>)['topMethodByRisk'] as string | null | undefined;
  if (sumTMBR) console.log(`  Top method (risk):  ${sumTMBR}`); // T757
  const sumR99 = (s as Record<string, unknown>)['riskScore99p'] as number | null | undefined;
  if (sumR99 != null) console.log(`  P99 risk:           ${sumR99.toFixed(3)}`); // T758
  const sumUMC = (s as Record<string, unknown>)['uniqueMethodCount'] as number | undefined;
  if (sumUMC != null) console.log(`  Unique methods:     ${sumUMC}`); // T759
  const sumR10 = (s as Record<string, unknown>)['riskScore10p'] as number | null | undefined;
  if (sumR10 != null) console.log(`  P10 risk:           ${sumR10.toFixed(3)}`); // T762
  const sumR75 = (s as Record<string, unknown>)['riskScore75p'] as number | null | undefined;
  if (sumR75 != null) console.log(`  P75 risk:           ${sumR75.toFixed(3)}`); // T763
  const sumR25 = (s as Record<string, unknown>)['riskScore25p'] as number | null | undefined;
  if (sumR25 != null) console.log(`  P25 risk:           ${sumR25.toFixed(3)}`); // T766
  const sumREB = (s as Record<string, unknown>)['riskEntropyBuckets'] as number | undefined;
  if (sumREB != null) console.log(`  Risk entropy:       ${sumREB.toFixed(3)}`); // T767
  const sumART = (s as Record<string, unknown>)['avgRiskByTool'] as Record<string, number> | undefined;
  if (sumART && Object.keys(sumART).length > 0) { const top3 = Object.entries(sumART).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${(v*100).toFixed(0)}%`).join(' '); console.log(`  Avg risk/tool:      ${top3}`); } // T768
  const sumBCT = (s as Record<string, unknown>)['blockCountByTool'] as Record<string, number> | undefined;
  if (sumBCT && Object.keys(sumBCT).length > 0) { const top3 = Object.entries(sumBCT).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Blocks/tool:        ${top3}`); } // T769
  const sumACT = (s as Record<string, unknown>)['allowCountByTool'] as Record<string, number> | undefined;
  if (sumACT && Object.keys(sumACT).length > 0) { const top3 = Object.entries(sumACT).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' '); console.log(`  Allows/tool:        ${top3}`); } // T770
  const sumOL5 = (s as Record<string, unknown>)['opsLast5m'] as number | undefined;
  if (sumOL5 != null) console.log(`  Ops last 5m:        ${sumOL5}`); // T771
  const sumBL5 = (s as Record<string, unknown>)['blocksLast5m'] as number | undefined;
  if (sumBL5 != null) console.log(`  Blocks last 5m:     ${sumBL5}`); // T772
  const sumHRI = (s as Record<string, unknown>)['highRiskOpIds'] as string[] | undefined;
  if (sumHRI && sumHRI.length > 0) console.log(`  High risk op IDs:   ${sumHRI.slice(0, 3).join(' ')}`); // T773
  const sumARP = (s as Record<string, unknown>)['approvalRatePercent'] as number | null | undefined;
  if (sumARP != null) console.log(`  Approval rate:      ${sumARP.toFixed(1)}%`); // T774
  const sumRCR = (s as Record<string, unknown>)['riskChangeRate'] as number | null | undefined;
  if (sumRCR != null) console.log(`  Risk change rate:   ${sumRCR.toFixed(3)}`); // T775
  const sumDD = (s as Record<string, unknown>)['decisionDistribution'] as Record<string, number> | undefined;
  if (sumDD) console.log(`  Decisions:          allow=${sumDD['allow']} block=${sumDD['block']} approval=${sumDD['require_approval']}`); // T776
  const sumOT = (s as Record<string, unknown>)['opsTrend12h'] as number | null | undefined;
  if (sumOT != null) console.log(`  Ops trend 12h:      ${sumOT.toFixed(2)}x`); // T777
  const sumARB = (s as Record<string, unknown>)['avgRiskOfBlocked'] as number | null | undefined;
  if (sumARB != null) console.log(`  Avg risk blocked:   ${sumARB.toFixed(3)}`); // T778
  const sumARA = (s as Record<string, unknown>)['avgRiskOfAllowed'] as number | null | undefined;
  if (sumARA != null) console.log(`  Avg risk allowed:   ${sumARA.toFixed(3)}`); // T779
  const sumRGB = (s as Record<string, unknown>)['riskGapBlockVsAllow'] as number | null | undefined;
  if (sumRGB != null) console.log(`  Risk gap b-a:       ${sumRGB.toFixed(3)}`); // T780
  const sumOL1 = (s as Record<string, unknown>)['opsLast1h'] as number | undefined;
  if (sumOL1 != null) console.log(`  Ops last 1h:        ${sumOL1}`); // T781
  const sumBL1 = (s as Record<string, unknown>)['blocksLast1h'] as number | undefined;
  if (sumBL1 != null) console.log(`  Blocks last 1h:     ${sumBL1}`); // T782
  const sumBRO = (s as Record<string, unknown>)['blockRateOverall'] as number | null | undefined;
  if (sumBRO != null) console.log(`  Block rate overall: ${(sumBRO*100).toFixed(1)}%`); // T783
  const sumARO = (s as Record<string, unknown>)['allowRateOverall'] as number | null | undefined;
  if (sumARO != null) console.log(`  Allow rate overall: ${(sumARO*100).toFixed(1)}%`); // T784
  const sumACO = (s as Record<string, unknown>)['approvalCountOverall'] as number | undefined;
  if (sumACO != null) console.log(`  Approval count:     ${sumACO}`); // T785
  const sumRB = (s as Record<string, unknown>)['riskBand'] as string | undefined;
  if (sumRB) console.log(`  Risk band:          ${sumRB}`); // T786
  const sumRAI_b = (s as Record<string, unknown>)['recentAllowedOpIds'] as string[] | undefined;
  if (sumRAI_b && sumRAI_b.length > 0) console.log(`  Recent allow IDs:   ${sumRAI_b.slice(0, 3).join(' ')}`); // T787
  const sumP95 = (s as Record<string, unknown>)['p95Risk'] as number | null | undefined;
  if (sumP95 != null) console.log(`  P95 risk:           ${sumP95.toFixed(3)}`); // T788
  const sumRCV = (s as Record<string, unknown>)['riskCV'] as number | null | undefined;
  if (sumRCV != null) console.log(`  Risk CV:            ${sumRCV.toFixed(3)}`); // T789
  const sumBSC = (s as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
  if (sumBSC != null && sumBSC > 0) console.log(`  Block streak now:   ${sumBSC}`); // T790
  const sumASC = (s as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
  if (sumASC != null && sumASC > 0) console.log(`  Allow streak now:   ${sumASC}`); // T791
  const sumRM = (s as Record<string, unknown>)['riskMomentum'] as number | null | undefined;
  if (sumRM != null) console.log(`  Risk momentum:      ${sumRM.toFixed(3)}`); // T792
  const sumOPA_b = (s as Record<string, unknown>)['opsPerAgent'] as number | null | undefined;
  if (sumOPA_b != null) console.log(`  Ops per agent:      ${sumOPA_b.toFixed(1)}`); // T793
  const sumOPT_b = (s as Record<string, unknown>)['opsPerTool'] as number | null | undefined;
  if (sumOPT_b != null) console.log(`  Ops per tool:       ${sumOPT_b.toFixed(1)}`); // T794
  const sumHRBC = (s as Record<string, unknown>)['highRiskBlockCount'] as number | undefined;
  if (sumHRBC != null) console.log(`  High-risk blocks:   ${sumHRBC}`); // T796
  const sumLRAC = (s as Record<string, unknown>)['lowRiskAllowCount'] as number | undefined;
  if (sumLRAC != null) console.log(`  Low-risk allows:    ${sumLRAC}`); // T797
  const sumRTHD = (s as Record<string, unknown>)['riskTrendHalfDay'] as number | null | undefined;
  if (sumRTHD != null) console.log(`  Risk trend 12h:     ${sumRTHD > 0 ? '+' : ''}${sumRTHD.toFixed(3)}`); // T798
  const sumMIM = (s as Record<string, unknown>)['medianIntervalMs'] as number | null | undefined;
  if (sumMIM != null) console.log(`  Median interval:    ${sumMIM.toFixed(0)}ms`); // T799
  const sumBRL6 = (s as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
  if (sumBRL6 != null) console.log(`  Block rate 6h:      ${(sumBRL6*100).toFixed(1)}%`); // T800
  const sumARL6 = (s as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
  if (sumARL6 != null) console.log(`  Allow rate 6h:      ${(sumARL6*100).toFixed(1)}%`); // T801
  const sumRDS = (s as Record<string, unknown>)['riskDecayScore'] as number | null | undefined;
  if (sumRDS != null) console.log(`  Risk decay score:   ${sumRDS.toFixed(3)}`); // T802
  const sumROI = (s as Record<string, unknown>)['recentOpIds'] as string[] | undefined;
  if (sumROI && sumROI.length > 0) console.log(`  Recent op IDs:      ${sumROI.slice(0, 3).join(' ')}`); // T803
  const sumBRL3 = (s as Record<string, unknown>)['blockRateLast3h'] as number | null | undefined;
  if (sumBRL3 != null) console.log(`  Block rate 3h:      ${(sumBRL3*100).toFixed(1)}%`); // T804
  const sumARL3 = (s as Record<string, unknown>)['allowRateLast3h'] as number | null | undefined;
  if (sumARL3 != null) console.log(`  Allow rate 3h:      ${(sumARL3*100).toFixed(1)}%`); // T805
  const sumOL3 = (s as Record<string, unknown>)['opsLast3h'] as number | undefined;
  if (sumOL3 != null) console.log(`  Ops last 3h:        ${sumOL3}`); // T806
  const sumTABO = (s as Record<string, unknown>)['topAgentByOps'] as string | null | undefined;
  if (sumTABO) console.log(`  Top agent (ops):    ${sumTABO}`); // T807
  const sumTABR_b = (s as Record<string, unknown>)['topAgentByRisk'] as string | null | undefined;
  if (sumTABR_b) console.log(`  Top agent (risk):   ${sumTABR_b}`); // T808
  const sumTTBO = (s as Record<string, unknown>)['topToolByOps'] as string | null | undefined;
  if (sumTTBO) console.log(`  Top tool (ops):     ${sumTTBO}`); // T809
  const sumTTBR_b = (s as Record<string, unknown>)['topToolByRisk'] as string | null | undefined;
  if (sumTTBR_b) console.log(`  Top tool (risk):    ${sumTTBR_b}`); // T810
  const sumBCL24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
  if (sumBCL24 != null) console.log(`  Blocks last 24h:    ${sumBCL24}`); // T811
  const sumACL24 = (s as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
  if (sumACL24 != null) console.log(`  Allows last 24h:    ${sumACL24}`); // T812
  const sumAPCL24 = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
  if (sumAPCL24 != null) console.log(`  Approvals last 24h: ${sumAPCL24}`); // T813
  const sumRAMC = (s as Record<string, unknown>)['riskAboveMedianCount'] as number | undefined;
  if (sumRAMC != null) console.log(`  Risk above median:  ${sumRAMC}`); // T814
  const sumRBMC = (s as Record<string, unknown>)['riskBelowMedianCount'] as number | undefined;
  if (sumRBMC != null) console.log(`  Risk below median:  ${sumRBMC}`); // T815
  const sumBD = (s as Record<string, unknown>)['blockDensity'] as number | null | undefined;
  if (sumBD != null) console.log(`  Block density:      ${sumBD.toFixed(1)}/1k`); // T816
  const sumAD = (s as Record<string, unknown>)['approvalDensity'] as number | null | undefined;
  if (sumAD != null) console.log(`  Approval density:   ${sumAD.toFixed(1)}/1k`); // T817
  const sumRVR = (s as Record<string, unknown>)['riskVolatilityRecent'] as number | null | undefined;
  if (sumRVR != null) console.log(`  Risk vol (recent):  ${sumRVR.toFixed(3)}`); // T818
  const sumRHBC = (s as Record<string, unknown>)['riskHighBandCount'] as number | undefined;
  if (sumRHBC != null) console.log(`  Risk high (>=0.7):  ${sumRHBC}`); // T819
  const sumRLBC = (s as Record<string, unknown>)['riskLowBandCount'] as number | undefined;
  if (sumRLBC != null) console.log(`  Risk low (<0.3):    ${sumRLBC}`); // T820
  const sumRMBC = (s as Record<string, unknown>)['riskMidBandCount'] as number | undefined;
  if (sumRMBC != null) console.log(`  Risk mid (0.3-0.7): ${sumRMBC}`); // T821
  const sumHSFO = (s as Record<string, unknown>)['hoursSinceFirstOp'] as number | null | undefined;
  if (sumHSFO != null) console.log(`  Hours since 1st op: ${sumHSFO.toFixed(1)}`); // T822
  const sumHSLO = (s as Record<string, unknown>)['hoursSinceLastOp'] as number | null | undefined;
  if (sumHSLO != null) console.log(`  Hours since last op:${sumHSLO.toFixed(1)}`); // T823
  const sumOL30_b = (s as Record<string, unknown>)['opsLast30m'] as number | undefined;
  if (sumOL30_b != null) console.log(`  Ops last 30m:       ${sumOL30_b}`); // T824
  const sumBL30 = (s as Record<string, unknown>)['blocksLast30m'] as number | undefined;
  if (sumBL30 != null) console.log(`  Blocks last 30m:    ${sumBL30}`); // T825
  const sumTSO = (s as Record<string, unknown>)['topSessionByOps'] as string | null | undefined;
  if (sumTSO != null) console.log(`  Top sess (ops):     ${sumTSO}`); // T826
  const sumTSR_b = (s as Record<string, unknown>)['topSessionByRisk'] as string | null | undefined;
  if (sumTSR_b != null) console.log(`  Top sess (risk):    ${sumTSR_b}`); // T827
  const sumUSC = (s as Record<string, unknown>)['uniqueSessionCount'] as number | undefined;
  if (sumUSC != null) console.log(`  Unique sessions:    ${sumUSC}`); // T828
  const sumUAC = (s as Record<string, unknown>)['uniqueAgentCount'] as number | undefined;
  if (sumUAC != null) console.log(`  Unique agents:      ${sumUAC}`); // T829
  const sumUTC_b = (s as Record<string, unknown>)['uniqueToolCount'] as number | undefined;
  if (sumUTC_b != null) console.log(`  Unique tools:       ${sumUTC_b}`); // T830
  const sumAOS = (s as Record<string, unknown>)['avgOpsPerSession'] as number | null | undefined;
  if (sumAOS != null) console.log(`  Avg ops/session:    ${sumAOS.toFixed(1)}`); // T831
  const sumTTB = (s as Record<string, unknown>)['topToolByBlocks'] as string | null | undefined;
  if (sumTTB != null) console.log(`  Top tool (blocks):  ${sumTTB}`); // T832
  const sumTAB = (s as Record<string, unknown>)['topAgentByBlocks'] as string | null | undefined;
  if (sumTAB != null) console.log(`  Top agent (blocks): ${sumTAB}`); // T833
  const sumBRL24 = (s as Record<string, unknown>)['blockRateLast24h'] as number | null | undefined;
  if (sumBRL24 != null) console.log(`  Block rate 24h:     ${(sumBRL24 * 100).toFixed(1)}%`); // T834
  const sumARL24 = (s as Record<string, unknown>)['allowRateLast24h'] as number | null | undefined;
  if (sumARL24 != null) console.log(`  Allow rate 24h:     ${(sumARL24 * 100).toFixed(1)}%`); // T835
  const sumAPRL24 = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
  if (sumAPRL24 != null) console.log(`  Approval rate 24h:  ${(sumAPRL24 * 100).toFixed(1)}%`); // T836
  const sumMCB = (s as Record<string, unknown>)['maxConsecutiveBlocks'] as number | undefined;
  if (sumMCB != null) console.log(`  Max consec blocks:  ${sumMCB}`); // T837
  const sumMCA = (s as Record<string, unknown>)['maxConsecutiveAllows'] as number | undefined;
  if (sumMCA != null) console.log(`  Max consec allows:  ${sumMCA}`); // T838
  const sumRSK = (s as Record<string, unknown>)['riskSkewness'] as number | null | undefined;
  if (sumRSK != null) console.log(`  Risk skewness:      ${sumRSK.toFixed(3)}`); // T839
  const sumRKT = (s as Record<string, unknown>)['riskKurtosis'] as number | null | undefined;
  if (sumRKT != null) console.log(`  Risk kurtosis:      ${sumRKT.toFixed(3)}`); // T840
  const sumOL15 = (s as Record<string, unknown>)['opsLast15m'] as number | undefined;
  if (sumOL15 != null) console.log(`  Ops last 15m:       ${sumOL15}`); // T841
  const sumBL15 = (s as Record<string, unknown>)['blocksLast15m'] as number | undefined;
  if (sumBL15 != null) console.log(`  Blocks last 15m:    ${sumBL15}`); // T842
  const sumHRR_b = (s as Record<string, unknown>)['highRiskRateOverall'] as number | null | undefined;
  if (sumHRR_b != null) console.log(`  High-risk rate:     ${(sumHRR_b * 100).toFixed(1)}%`); // T843
  const sumLRR_b = (s as Record<string, unknown>)['lowRiskRateOverall'] as number | null | undefined;
  if (sumLRR_b != null) console.log(`  Low-risk rate:      ${(sumLRR_b * 100).toFixed(1)}%`); // T844
  const sumMRR_b = (s as Record<string, unknown>)['midRiskRateOverall'] as number | null | undefined;
  if (sumMRR_b != null) console.log(`  Mid-risk rate:      ${(sumMRR_b * 100).toFixed(1)}%`); // T845
  const sumRRG = (s as Record<string, unknown>)['riskRange'] as number | null | undefined;
  if (sumRRG != null) console.log(`  Risk range:         ${sumRRG.toFixed(3)}`); // T846
  const sumFOT_b = (s as Record<string, unknown>)['firstOpTimestamp'] as string | null | undefined;
  if (sumFOT_b != null) console.log(`  First op at:        ${sumFOT_b}`); // T847
  const sumLOT_b = (s as Record<string, unknown>)['lastOpTimestamp'] as string | null | undefined;
  if (sumLOT_b != null) console.log(`  Last op at:         ${sumLOT_b}`); // T848
  const sumTDMs = (s as Record<string, unknown>)['totalDurationMs'] as number | null | undefined;
  if (sumTDMs != null) console.log(`  Total duration:     ${(sumTDMs / 3600000).toFixed(1)}h`); // T849
  const sumOPH = (s as Record<string, unknown>)['opsPerHour'] as number | null | undefined;
  if (sumOPH != null) console.log(`  Ops per hour:       ${sumOPH.toFixed(1)}`); // T850
  const sumBPH = (s as Record<string, unknown>)['blocksPerHour'] as number | null | undefined;
  if (sumBPH != null) console.log(`  Blocks per hour:    ${sumBPH.toFixed(1)}`); // T851
  const sumRWBC = (s as Record<string, unknown>)['riskWeightedBlockCount'] as number | undefined;
  if (sumRWBC != null) console.log(`  Risk-wtd blocks:    ${sumRWBC.toFixed(2)}`); // T852
  const sumRWAC = (s as Record<string, unknown>)['riskWeightedAllowCount'] as number | undefined;
  if (sumRWAC != null) console.log(`  Risk-wtd allows:    ${sumRWAC.toFixed(2)}`); // T853
  const sumARL10_b = (s as Record<string, unknown>)['avgRiskLast10'] as number | null | undefined;
  if (sumARL10_b != null) console.log(`  Avg risk last 10:   ${sumARL10_b.toFixed(3)}`); // T854
  const sumARF10_b = (s as Record<string, unknown>)['avgRiskFirst10'] as number | null | undefined;
  if (sumARF10_b != null) console.log(`  Avg risk first 10:  ${sumARF10_b.toFixed(3)}`); // T855
  const sumRTF10 = (s as Record<string, unknown>)['riskTrendFirst10vsLast10'] as number | null | undefined;
  if (sumRTF10 != null) console.log(`  Risk trend (10):    ${sumRTF10 >= 0 ? '+' : ''}${sumRTF10.toFixed(3)}`); // T856
  const sumBCL7 = (s as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
  if (sumBCL7 != null) console.log(`  Blocks last 7d:     ${sumBCL7}`); // T857
  const sumACL7 = (s as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
  if (sumACL7 != null) console.log(`  Allows last 7d:     ${sumACL7}`); // T858
  const sumAPCL7 = (s as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
  if (sumAPCL7 != null) console.log(`  Approvals last 7d:  ${sumAPCL7}`); // T859
  const sumOCL7 = (s as Record<string, unknown>)['opsCountLast7d'] as number | undefined;
  if (sumOCL7 != null) console.log(`  Ops last 7d:        ${sumOCL7}`); // T860
  const sumRSA = (s as Record<string, unknown>)['riskSumAll'] as number | undefined;
  if (sumRSA != null) console.log(`  Risk sum (all):     ${sumRSA.toFixed(2)}`); // T861
  const sumAIM = (s as Record<string, unknown>)['avgIntervalMs'] as number | null | undefined;
  if (sumAIM != null) console.log(`  Avg interval:       ${(sumAIM / 1000).toFixed(1)}s`); // T862
  const sumMNR = (s as Record<string, unknown>)['minRisk'] as number | null | undefined;
  if (sumMNR != null) console.log(`  Min risk:           ${sumMNR.toFixed(3)}`); // T863
  const sumMXR = (s as Record<string, unknown>)['maxRisk'] as number | null | undefined;
  if (sumMXR != null) console.log(`  Max risk:           ${sumMXR.toFixed(3)}`); // T864
  const sumRIQR_b = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
  if (sumRIQR_b != null) console.log(`  Risk IQR:           ${sumRIQR_b.toFixed(3)}`); // T865
  const sumBRC1 = (s as Record<string, unknown>)['blockRateChange1h'] as number | undefined;
  if (sumBRC1 != null) console.log(`  Block rate Δ1h:     ${sumBRC1 >= 0 ? '+' : ''}${(sumBRC1 * 100).toFixed(1)}%`); // T866
  const sumOT1 = (s as Record<string, unknown>)['opsTrend1h'] as number | null | undefined;
  if (sumOT1 != null) console.log(`  Ops trend 1h:       ${sumOT1.toFixed(2)}x`); // T867
  const sumBT6 = (s as Record<string, unknown>)['blockTrend6h'] as number | null | undefined;
  if (sumBT6 != null) console.log(`  Block trend 6h:     ${sumBT6.toFixed(2)}x`); // T868
  const sumAT6 = (s as Record<string, unknown>)['allowTrend6h'] as number | null | undefined;
  if (sumAT6 != null) console.log(`  Allow trend 6h:     ${sumAT6.toFixed(2)}x`); // T869
  const sumBRA = (s as Record<string, unknown>)['blockRatioToAllow'] as number | null | undefined;
  if (sumBRA != null) console.log(`  Block/allow ratio:  ${sumBRA.toFixed(2)}`); // T870
  const sumARB_b = (s as Record<string, unknown>)['approvalRatioToBlock'] as number | null | undefined;
  if (sumARB_b != null) console.log(`  Approval/block:     ${sumARB_b.toFixed(2)}`); // T871
  const sumOL2 = (s as Record<string, unknown>)['opsLast2h'] as number | undefined;
  if (sumOL2 != null) console.log(`  Ops last 2h:        ${sumOL2}`); // T872
  const sumBL2 = (s as Record<string, unknown>)['blocksLast2h'] as number | undefined;
  if (sumBL2 != null) console.log(`  Blocks last 2h:     ${sumBL2}`); // T873
  const sumAL2 = (s as Record<string, unknown>)['allowsLast2h'] as number | undefined;
  if (sumAL2 != null) console.log(`  Allows last 2h:     ${sumAL2}`); // T874
  const sumOL4 = (s as Record<string, unknown>)['opsLast4h'] as number | undefined;
  if (sumOL4 != null) console.log(`  Ops last 4h:        ${sumOL4}`); // T875
  const sumBL4 = (s as Record<string, unknown>)['blocksLast4h'] as number | undefined;
  if (sumBL4 != null) console.log(`  Blocks last 4h:     ${sumBL4}`); // T876
  const sumBR4 = (s as Record<string, unknown>)['blockRateLast4h'] as number | null | undefined;
  if (sumBR4 != null) console.log(`  Block rate 4h:      ${(sumBR4 * 100).toFixed(1)}%`); // T877
  const sumRSD_b = (s as Record<string, unknown>)['riskStdDev'] as number | null | undefined;
  if (sumRSD_b != null) console.log(`  Risk std dev:       ${sumRSD_b.toFixed(3)}`); // T878
  const sumAL4 = (s as Record<string, unknown>)['allowsLast4h'] as number | undefined;
  if (sumAL4 != null) console.log(`  Allows last 4h:     ${sumAL4}`); // T879
  const sumAR4 = (s as Record<string, unknown>)['allowRateLast4h'] as number | null | undefined;
  if (sumAR4 != null) console.log(`  Allow rate 4h:      ${(sumAR4 * 100).toFixed(1)}%`); // T880
  const sumOL12 = (s as Record<string, unknown>)['opsLast12h'] as number | undefined;
  if (sumOL12 != null) console.log(`  Ops last 12h:       ${sumOL12}`); // T881
  const sumBL12 = (s as Record<string, unknown>)['blocksLast12h'] as number | undefined;
  if (sumBL12 != null) console.log(`  Blocks last 12h:    ${sumBL12}`); // T882
  const sumAL12 = (s as Record<string, unknown>)['allowsLast12h'] as number | undefined;
  if (sumAL12 != null) console.log(`  Allows last 12h:    ${sumAL12}`); // T883
  const sumBR12 = (s as Record<string, unknown>)['blockRateLast12h'] as number | null | undefined;
  if (sumBR12 != null) console.log(`  Block rate 12h:     ${(sumBR12 * 100).toFixed(1)}%`); // T884
  const sumAR12 = (s as Record<string, unknown>)['allowRateLast12h'] as number | null | undefined;
  if (sumAR12 != null) console.log(`  Allow rate 12h:     ${(sumAR12 * 100).toFixed(1)}%`); // T885
  const sumOL48 = (s as Record<string, unknown>)['opsLast48h'] as number | undefined;
  if (sumOL48 != null) console.log(`  Ops last 48h:       ${sumOL48}`); // T886
  const sumBL48 = (s as Record<string, unknown>)['blocksLast48h'] as number | undefined;
  if (sumBL48 != null) console.log(`  Blocks last 48h:    ${sumBL48}`); // T887
  const sumAL48 = (s as Record<string, unknown>)['allowsLast48h'] as number | undefined;
  if (sumAL48 != null) console.log(`  Allows last 48h:    ${sumAL48}`); // T888
  const sumBR48 = (s as Record<string, unknown>)['blockRateLast48h'] as number | null | undefined;
  if (sumBR48 != null) console.log(`  Block rate 48h:     ${(sumBR48 * 100).toFixed(1)}%`); // T889
  const sumAR48 = (s as Record<string, unknown>)['allowRateLast48h'] as number | null | undefined;
  if (sumAR48 != null) console.log(`  Allow rate 48h:     ${(sumAR48 * 100).toFixed(1)}%`); // T890
  const sumAPC24 = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
  if (sumAPC24 != null) console.log(`  Approvals last 24h: ${sumAPC24}`); // T891
  const sumAPR24 = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
  if (sumAPR24 != null) console.log(`  Approval rate 24h:  ${(sumAPR24 * 100).toFixed(1)}%`); // T892
  const sumRCV_b = (s as Record<string, unknown>)['riskCvPct'] as number | null | undefined;
  if (sumRCV_b != null) console.log(`  Risk CV%:           ${sumRCV_b.toFixed(1)}%`); // T893
  const sumAPC48 = (s as Record<string, unknown>)['approvalCountLast48h'] as number | undefined;
  if (sumAPC48 != null) console.log(`  Approvals last 48h: ${sumAPC48}`); // T894
  const sumAPC12 = (s as Record<string, unknown>)['approvalCountLast12h'] as number | undefined;
  if (sumAPC12 != null) console.log(`  Approvals last 12h: ${sumAPC12}`); // T895
  const sumP50 = (s as Record<string, unknown>)['p50Risk'] as number | null | undefined;
  if (sumP50 != null) console.log(`  Risk p50:           ${sumP50.toFixed(3)}`); // T896
  const sumP90_b = (s as Record<string, unknown>)['p90Risk'] as number | null | undefined;
  if (sumP90_b != null) console.log(`  Risk p90:           ${sumP90_b.toFixed(3)}`); // T897
  const sumP10 = (s as Record<string, unknown>)['p10Risk'] as number | null | undefined;
  if (sumP10 != null) console.log(`  Risk p10:           ${sumP10.toFixed(3)}`); // T898
  const sumBC30d = (s as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
  if (sumBC30d != null) console.log(`  Blocks last 30d:    ${sumBC30d}`); // T899
  const sumAC30d = (s as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
  if (sumAC30d != null) console.log(`  Allows last 30d:    ${sumAC30d}`); // T900
  const sumOL30d = (s as Record<string, unknown>)['opsLast30d'] as number | undefined;
  if (sumOL30d != null) console.log(`  Ops last 30d:       ${sumOL30d}`); // T901
  const sumBR30d = (s as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
  if (sumBR30d != null) console.log(`  Block rate 30d:     ${(sumBR30d * 100).toFixed(1)}%`); // T902
  const sumAR30d = (s as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
  if (sumAR30d != null) console.log(`  Avg risk 30d:       ${sumAR30d.toFixed(3)}`); // T903
  const sumAPR48 = (s as Record<string, unknown>)['approvalRateLast48h'] as number | null | undefined;
  if (sumAPR48 != null) console.log(`  Approval rate 48h:  ${(sumAPR48 * 100).toFixed(1)}%`); // T904
  const sumAPR12 = (s as Record<string, unknown>)['approvalRateLast12h'] as number | null | undefined;
  if (sumAPR12 != null) console.log(`  Approval rate 12h:  ${(sumAPR12 * 100).toFixed(1)}%`); // T905
  const sumAPR30d = (s as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
  if (sumAPR30d != null) console.log(`  Approval rate 30d:  ${(sumAPR30d * 100).toFixed(1)}%`); // T906
  const sumHRC24 = (s as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
  if (sumHRC24 != null) console.log(`  High risk last 24h: ${sumHRC24}`); // T907
  const sumHRC7d = (s as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
  if (sumHRC7d != null) console.log(`  High risk last 7d:  ${sumHRC7d}`); // T908
  const sumHRC30d = (s as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
  if (sumHRC30d != null) console.log(`  High risk last 30d: ${sumHRC30d}`); // T909
  const sumLRC24 = (s as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
  if (sumLRC24 != null) console.log(`  Low risk last 24h:  ${sumLRC24}`); // T910
  const sumLRC7d = (s as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
  if (sumLRC7d != null) console.log(`  Low risk last 7d:   ${sumLRC7d}`); // T911
  const sumARL7d = (s as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
  if (sumARL7d != null) console.log(`  Avg risk 7d:        ${sumARL7d.toFixed(3)}`); // T912
  const sumARL24_b = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
  if (sumARL24_b != null) console.log(`  Avg risk 24h:       ${sumARL24_b.toFixed(3)}`); // T913
  const sumARL48 = (s as Record<string, unknown>)['avgRiskLast48h'] as number | null | undefined;
  if (sumARL48 != null) console.log(`  Avg risk 48h:       ${sumARL48.toFixed(3)}`); // T914
  const sumARL12 = (s as Record<string, unknown>)['avgRiskLast12h'] as number | null | undefined;
  if (sumARL12 != null) console.log(`  Avg risk 12h:       ${sumARL12.toFixed(3)}`); // T915
  const sumLRC30d = (s as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
  if (sumLRC30d != null) console.log(`  Low risk last 30d:  ${sumLRC30d}`); // T916
  const sumLRC48 = (s as Record<string, unknown>)['lowRiskCountLast48h'] as number | undefined;
  if (sumLRC48 != null) console.log(`  Low risk last 48h:  ${sumLRC48}`); // T917
  const sumLRC12 = (s as Record<string, unknown>)['lowRiskCountLast12h'] as number | undefined;
  if (sumLRC12 != null) console.log(`  Low risk last 12h:  ${sumLRC12}`); // T918
  const sumHRC48 = (s as Record<string, unknown>)['highRiskCountLast48h'] as number | undefined;
  if (sumHRC48 != null) console.log(`  High risk last 48h: ${sumHRC48}`); // T919
  const sumHRC12 = (s as Record<string, unknown>)['highRiskCountLast12h'] as number | undefined;
  if (sumHRC12 != null) console.log(`  High risk last 12h: ${sumHRC12}`); // T920
  const sumMRC24 = (s as Record<string, unknown>)['midRiskCountLast24h'] as number | undefined;
  if (sumMRC24 != null) console.log(`  Mid risk last 24h:  ${sumMRC24}`); // T921
  const sumMRC7d = (s as Record<string, unknown>)['midRiskCountLast7d'] as number | undefined;
  if (sumMRC7d != null) console.log(`  Mid risk last 7d:   ${sumMRC7d}`); // T922
  const sumMRC30d = (s as Record<string, unknown>)['midRiskCountLast30d'] as number | undefined;
  if (sumMRC30d != null) console.log(`  Mid risk last 30d:  ${sumMRC30d}`); // T923
  const sumMRC48 = (s as Record<string, unknown>)['midRiskCountLast48h'] as number | undefined;
  if (sumMRC48 != null) console.log(`  Mid risk last 48h:  ${sumMRC48}`); // T924
  const sumMRC12 = (s as Record<string, unknown>)['midRiskCountLast12h'] as number | undefined;
  if (sumMRC12 != null) console.log(`  Mid risk last 12h:  ${sumMRC12}`); // T925
  const sumOL6 = (s as Record<string, unknown>)['opsLast6h'] as number | undefined;
  if (sumOL6 != null) console.log(`  Ops last 6h:        ${sumOL6}`); // T926
  const sumBL6 = (s as Record<string, unknown>)['blocksLast6h'] as number | undefined;
  if (sumBL6 != null) console.log(`  Blocks last 6h:     ${sumBL6}`); // T927
  const sumAL6 = (s as Record<string, unknown>)['allowsLast6h'] as number | undefined;
  if (sumAL6 != null) console.log(`  Allows last 6h:     ${sumAL6}`); // T928
  const sumBR6 = (s as Record<string, unknown>)['blockRateLast6h'] as number | null | undefined;
  if (sumBR6 != null) console.log(`  Block rate 6h:      ${(sumBR6 * 100).toFixed(1)}%`); // T929
  const sumAR6 = (s as Record<string, unknown>)['allowRateLast6h'] as number | null | undefined;
  if (sumAR6 != null) console.log(`  Allow rate 6h:      ${(sumAR6 * 100).toFixed(1)}%`); // T930
  const sumAPC6 = (s as Record<string, unknown>)['approvalCountLast6h'] as number | undefined;
  if (sumAPC6 != null) console.log(`  Approvals last 6h:  ${sumAPC6}`); // T931
  const sumARL6_b = (s as Record<string, unknown>)['avgRiskLast6h'] as number | null | undefined;
  if (sumARL6_b != null) console.log(`  Avg risk 6h:        ${sumARL6_b.toFixed(3)}`); // T932
  const sumHRC6 = (s as Record<string, unknown>)['highRiskCountLast6h'] as number | undefined;
  if (sumHRC6 != null) console.log(`  High risk last 6h:  ${sumHRC6}`); // T933
  const sumLRC6 = (s as Record<string, unknown>)['lowRiskCountLast6h'] as number | undefined;
  if (sumLRC6 != null) console.log(`  Low risk last 6h:   ${sumLRC6}`); // T934
  const sumMRC6 = (s as Record<string, unknown>)['midRiskCountLast6h'] as number | undefined;
  if (sumMRC6 != null) console.log(`  Mid risk last 6h:   ${sumMRC6}`); // T935
  const sumRV6 = (s as Record<string, unknown>)['riskVolatilityLast6h'] as number | null | undefined;
  if (sumRV6 != null) console.log(`  Risk volatility 6h: ${sumRV6.toFixed(3)}`); // T936
  const sumBSC_b = (s as Record<string, unknown>)['blockStreakCurrent'] as number | undefined;
  if (sumBSC_b != null && sumBSC_b > 0) console.log(`  Block streak:       ${sumBSC_b}`); // T937
  const sumASC_b = (s as Record<string, unknown>)['allowStreakCurrent'] as number | undefined;
  if (sumASC_b != null && sumASC_b > 0) console.log(`  Allow streak:       ${sumASC_b}`); // T938
  const sumAPSC = (s as Record<string, unknown>)['approvalStreakCurrent'] as number | undefined;
  if (sumAPSC != null && sumAPSC > 0) console.log(`  Approval streak:    ${sumAPSC}`); // T939
  const sumRV24 = (s as Record<string, unknown>)['riskVolatilityLast24h'] as number | null | undefined;
  if (sumRV24 != null) console.log(`  Risk volatility 24h:${sumRV24.toFixed(3)}`); // T940
  const sumRV7d = (s as Record<string, unknown>)['riskVolatilityLast7d'] as number | null | undefined;
  if (sumRV7d != null) console.log(`  Risk volatility 7d: ${sumRV7d.toFixed(3)}`); // T941
  const sumBRL6_b = (s as Record<string, unknown>)['blockRatioLast6h'] as number | null | undefined;
  if (sumBRL6_b != null) console.log(`  Block ratio 6h:     ${(sumBRL6_b * 100).toFixed(1)}%`); // T942
  const sumBRL24_b = (s as Record<string, unknown>)['blockRatioLast24h'] as number | null | undefined;
  if (sumBRL24_b != null) console.log(`  Block ratio 24h:    ${(sumBRL24_b * 100).toFixed(1)}%`); // T943
  const sumBRL7d = (s as Record<string, unknown>)['blockRatioLast7d'] as number | null | undefined;
  if (sumBRL7d != null) console.log(`  Block ratio 7d:     ${(sumBRL7d * 100).toFixed(1)}%`); // T944
  const sumBRL30d = (s as Record<string, unknown>)['blockRatioLast30d'] as number | null | undefined;
  if (sumBRL30d != null) console.log(`  Block ratio 30d:    ${(sumBRL30d * 100).toFixed(1)}%`); // T945
  const sumAIM24 = (s as Record<string, unknown>)['avgIntervalMsLast24h'] as number | null | undefined;
  if (sumAIM24 != null) console.log(`  Avg interval 24h:   ${Math.round(sumAIM24 / 1000)}s`); // T946
  const sumAIM7d = (s as Record<string, unknown>)['avgIntervalMsLast7d'] as number | null | undefined;
  if (sumAIM7d != null) console.log(`  Avg interval 7d:    ${Math.round(sumAIM7d / 1000)}s`); // T947
  const sumPHOD_b = (s as Record<string, unknown>)['peakHourOfDay'] as number | null | undefined;
  if (sumPHOD_b != null) console.log(`  Peak hour (UTC):    ${sumPHOD_b}:00`); // T948
  const days7 = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const sumPDOW = (s as Record<string, unknown>)['peakDayOfWeek'] as number | null | undefined;
  if (sumPDOW != null) console.log(`  Peak day:           ${days7[sumPDOW]}`); // T949
  const sumLADOW = (s as Record<string, unknown>)['leastActiveDayOfWeek'] as number | null | undefined;
  if (sumLADOW != null) console.log(`  Least active day:   ${days7[sumLADOW]}`); // T950
  const sumLAHOD = (s as Record<string, unknown>)['leastActiveHourOfDay'] as number | null | undefined;
  if (sumLAHOD != null) console.log(`  Least active hour:  ${sumLAHOD}:00`); // T951
  const sumOL1_b = (s as Record<string, unknown>)['opsLast1h'] as number | undefined;
  if (sumOL1_b != null) console.log(`  Ops last 1h:        ${sumOL1_b}`); // T952
  const sumBL1_b = (s as Record<string, unknown>)['blocksLast1h'] as number | undefined;
  if (sumBL1_b != null) console.log(`  Blocks last 1h:     ${sumBL1_b}`); // T953
  const sumAL1 = (s as Record<string, unknown>)['allowsLast1h'] as number | undefined;
  if (sumAL1 != null) console.log(`  Allows last 1h:     ${sumAL1}`); // T954
  const sumARL1 = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
  if (sumARL1 != null) console.log(`  Avg risk 1h:        ${sumARL1.toFixed(3)}`); // T955
  const sumHRC1 = (s as Record<string, unknown>)['highRiskCountLast1h'] as number | undefined;
  if (sumHRC1 != null) console.log(`  High risk last 1h:  ${sumHRC1}`); // T956
  const sumBR1 = (s as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
  if (sumBR1 != null) console.log(`  Block rate 1h:      ${(sumBR1 * 100).toFixed(1)}%`); // T957
  const sumAR1 = (s as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
  if (sumAR1 != null) console.log(`  Allow rate 1h:      ${(sumAR1 * 100).toFixed(1)}%`); // T958
  const sumAPR1 = (s as Record<string, unknown>)['approvalRateLast1h'] as number | null | undefined;
  if (sumAPR1 != null) console.log(`  Approval rate 1h:   ${(sumAPR1 * 100).toFixed(1)}%`); // T959
  const sumRV1 = (s as Record<string, unknown>)['riskVolatilityLast1h'] as number | null | undefined;
  if (sumRV1 != null) console.log(`  Risk volatility 1h: ${sumRV1.toFixed(3)}`); // T960
  const sumAPC1 = (s as Record<string, unknown>)['approvalCountLast1h'] as number | undefined;
  if (sumAPC1 != null) console.log(`  Approvals last 1h:  ${sumAPC1}`); // T961
  const sumLRC1 = (s as Record<string, unknown>)['lowRiskCountLast1h'] as number | undefined;
  if (sumLRC1 != null) console.log(`  Low risk last 1h:   ${sumLRC1}`); // T962
  const sumMRC1 = (s as Record<string, unknown>)['midRiskCountLast1h'] as number | undefined;
  if (sumMRC1 != null) console.log(`  Mid risk last 1h:   ${sumMRC1}`); // T963
  const sumBRL1 = (s as Record<string, unknown>)['blockRatioLast1h'] as number | null | undefined;
  if (sumBRL1 != null) console.log(`  Block ratio 1h:     ${(sumBRL1 * 100).toFixed(1)}%`); // T964
  const sumRWB24 = (s as Record<string, unknown>)['riskWeightedBlocksLast24h'] as number | null | undefined;
  if (sumRWB24 != null) console.log(`  Risk-wtd blocks 24h:${sumRWB24.toFixed(2)}`); // T965
  const sumRWA24 = (s as Record<string, unknown>)['riskWeightedAllowsLast24h'] as number | null | undefined;
  if (sumRWA24 != null) console.log(`  Risk-wtd allows 24h:${sumRWA24.toFixed(2)}`); // T966
  const sumRWB7 = (s as Record<string, unknown>)['riskWeightedBlocksLast7d'] as number | null | undefined;
  if (sumRWB7 != null) console.log(`  Risk-wtd blocks 7d: ${sumRWB7.toFixed(2)}`); // T967
  const sumRWA7 = (s as Record<string, unknown>)['riskWeightedAllowsLast7d'] as number | null | undefined;
  if (sumRWA7 != null) console.log(`  Risk-wtd allows 7d: ${sumRWA7.toFixed(2)}`); // T968
  const sumRWB30 = (s as Record<string, unknown>)['riskWeightedBlocksLast30d'] as number | null | undefined;
  if (sumRWB30 != null) console.log(`  Risk-wtd blocks 30d:${sumRWB30.toFixed(2)}`); // T969
  const sumRWA30 = (s as Record<string, unknown>)['riskWeightedAllowsLast30d'] as number | null | undefined;
  if (sumRWA30 != null) console.log(`  Risk-wtd allows 30d:${sumRWA30.toFixed(2)}`); // T970
  const sumNRW24 = (s as Record<string, unknown>)['netRiskWeightLast24h'] as number | undefined;
  if (sumNRW24 != null) console.log(`  Net risk weight 24h:${sumNRW24.toFixed(2)}`); // T971
  const sumNRW7 = (s as Record<string, unknown>)['netRiskWeightLast7d'] as number | undefined;
  if (sumNRW7 != null) console.log(`  Net risk weight 7d: ${sumNRW7.toFixed(2)}`); // T972
  const sumARWB24 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast24h'] as number | null | undefined;
  if (sumARWB24 != null) console.log(`  Avg risk/block 24h: ${sumARWB24.toFixed(3)}`); // T973
  const sumARWA24 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast24h'] as number | null | undefined;
  if (sumARWA24 != null) console.log(`  Avg risk/allow 24h: ${sumARWA24.toFixed(3)}`); // T974
  const sumARWB7 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast7d'] as number | null | undefined;
  if (sumARWB7 != null) console.log(`  Avg risk/block 7d:  ${sumARWB7.toFixed(3)}`); // T975
  const sumARWA7 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast7d'] as number | null | undefined;
  if (sumARWA7 != null) console.log(`  Avg risk/allow 7d:  ${sumARWA7.toFixed(3)}`); // T976
  const sumNRW30 = (s as Record<string, unknown>)['netRiskWeightLast30d'] as number | undefined;
  if (sumNRW30 != null) console.log(`  Net risk weight 30d:${sumNRW30.toFixed(2)}`); // T977
  const sumARWB30 = (s as Record<string, unknown>)['avgRiskWeightPerBlockLast30d'] as number | null | undefined;
  if (sumARWB30 != null) console.log(`  Avg risk/block 30d: ${sumARWB30.toFixed(3)}`); // T978
  const sumARWA30 = (s as Record<string, unknown>)['avgRiskWeightPerAllowLast30d'] as number | null | undefined;
  if (sumARWA30 != null) console.log(`  Avg risk/allow 30d: ${sumARWA30.toFixed(3)}`); // T979
  const sumBAR24 = (s as Record<string, unknown>)['blockToAllowRatioLast24h'] as number | null | undefined;
  if (sumBAR24 != null) console.log(`  Block:allow ratio 24h:${sumBAR24.toFixed(2)}`); // T980
  const sumBAR7 = (s as Record<string, unknown>)['blockToAllowRatioLast7d'] as number | null | undefined;
  if (sumBAR7 != null) console.log(`  Block:allow ratio 7d: ${sumBAR7.toFixed(2)}`); // T981
  const sumBAR30 = (s as Record<string, unknown>)['blockToAllowRatioLast30d'] as number | null | undefined;
  if (sumBAR30 != null) console.log(`  Block:allow ratio 30d:${sumBAR30.toFixed(2)}`); // T982
  const sumRSM24 = (s as Record<string, unknown>)['riskScoreMomentumLast24h'] as number | null | undefined;
  if (sumRSM24 != null) console.log(`  Risk momentum 24h:  ${sumRSM24 >= 0 ? '+' : ''}${sumRSM24.toFixed(3)}`); // T983
  const sumRSM7 = (s as Record<string, unknown>)['riskScoreMomentumLast7d'] as number | null | undefined;
  if (sumRSM7 != null) console.log(`  Risk momentum 7d:   ${sumRSM7 >= 0 ? '+' : ''}${sumRSM7.toFixed(3)}`); // T984
  const sumATBR24 = (s as Record<string, unknown>)['approvalToBlockRatioLast24h'] as number | null | undefined;
  if (sumATBR24 != null) console.log(`  Approval:block 24h: ${sumATBR24.toFixed(2)}`); // T985
  const sumATBR7 = (s as Record<string, unknown>)['approvalToBlockRatioLast7d'] as number | null | undefined;
  if (sumATBR7 != null) console.log(`  Approval:block 7d:  ${sumATBR7.toFixed(2)}`); // T986
  const sumOPH24 = (s as Record<string, unknown>)['opsPerHourLast24h'] as number | undefined;
  if (sumOPH24 != null) console.log(`  Ops/hour last 24h:  ${sumOPH24.toFixed(2)}`); // T987
  const sumOPH7 = (s as Record<string, unknown>)['opsPerHourLast7d'] as number | undefined;
  if (sumOPH7 != null) console.log(`  Ops/hour last 7d:   ${sumOPH7.toFixed(2)}`); // T988
  const sumOPH30 = (s as Record<string, unknown>)['opsPerHourLast30d'] as number | undefined;
  if (sumOPH30 != null) console.log(`  Ops/hour last 30d:  ${sumOPH30.toFixed(2)}`); // T989
  const sumBPH24 = (s as Record<string, unknown>)['blocksPerHourLast24h'] as number | undefined;
  if (sumBPH24 != null) console.log(`  Blocks/hr 24h:      ${sumBPH24.toFixed(2)}`); // T990
  const sumBPH7 = (s as Record<string, unknown>)['blocksPerHourLast7d'] as number | undefined;
  if (sumBPH7 != null) console.log(`  Blocks/hr 7d:       ${sumBPH7.toFixed(2)}`); // T991
  const sumAPH24 = (s as Record<string, unknown>)['allowsPerHourLast24h'] as number | undefined;
  if (sumAPH24 != null) console.log(`  Allows/hr 24h:      ${sumAPH24.toFixed(2)}`); // T992
  const sumAPH7 = (s as Record<string, unknown>)['allowsPerHourLast7d'] as number | undefined;
  if (sumAPH7 != null) console.log(`  Allows/hr 7d:       ${sumAPH7.toFixed(2)}`); // T993
  const sumAPH30 = (s as Record<string, unknown>)['allowsPerHourLast30d'] as number | undefined;
  if (sumAPH30 != null) console.log(`  Allows/hr 30d:      ${sumAPH30.toFixed(2)}`); // T994
  const sumBPH30 = (s as Record<string, unknown>)['blocksPerHourLast30d'] as number | undefined;
  if (sumBPH30 != null) console.log(`  Blocks/hr 30d:      ${sumBPH30.toFixed(2)}`); // T995
  const sumHRPH24 = (s as Record<string, unknown>)['highRiskOpsPerHourLast24h'] as number | undefined;
  if (sumHRPH24 != null) console.log(`  HiRisk ops/hr 24h:  ${sumHRPH24.toFixed(2)}`); // T996
  const sumHRPH7 = (s as Record<string, unknown>)['highRiskOpsPerHourLast7d'] as number | undefined;
  if (sumHRPH7 != null) console.log(`  HiRisk ops/hr 7d:   ${sumHRPH7.toFixed(2)}`); // T997
  const sumUTC24 = (s as Record<string, unknown>)['uniqueToolsCountLast24h'] as number | undefined;
  if (sumUTC24 != null) console.log(`  Unique tools 24h:   ${sumUTC24}`); // T998
  const sumUTC7 = (s as Record<string, unknown>)['uniqueToolsCountLast7d'] as number | undefined;
  if (sumUTC7 != null) console.log(`  Unique tools 7d:    ${sumUTC7}`); // T999
  const sumUAC24 = (s as Record<string, unknown>)['uniqueAgentsCountLast24h'] as number | undefined;
  if (sumUAC24 != null) console.log(`  Unique agents 24h:  ${sumUAC24}`); // T1000
  const sumUAC7 = (s as Record<string, unknown>)['uniqueAgentsCountLast7d'] as number | undefined;
  if (sumUAC7 != null) console.log(`  Unique agents 7d:   ${sumUAC7}`); // T1001
  const sumMXR24 = (s as Record<string, unknown>)['maxRiskLast24h'] as number | null | undefined;
  if (sumMXR24 != null) console.log(`  Max risk 24h:       ${sumMXR24.toFixed(3)}`); // T1002
  const sumMXR7 = (s as Record<string, unknown>)['maxRiskLast7d'] as number | null | undefined;
  if (sumMXR7 != null) console.log(`  Max risk 7d:        ${sumMXR7.toFixed(3)}`); // T1003
  const sumMNR24 = (s as Record<string, unknown>)['minRiskLast24h'] as number | null | undefined;
  if (sumMNR24 != null) console.log(`  Min risk 24h:       ${sumMNR24.toFixed(3)}`); // T1004
  const sumMNR7 = (s as Record<string, unknown>)['minRiskLast7d'] as number | null | undefined;
  if (sumMNR7 != null) console.log(`  Min risk 7d:        ${sumMNR7.toFixed(3)}`); // T1005
  const sumMXR30 = (s as Record<string, unknown>)['maxRiskLast30d'] as number | null | undefined;
  if (sumMXR30 != null) console.log(`  Max risk 30d:       ${sumMXR30.toFixed(3)}`); // T1006
  const sumMNR30 = (s as Record<string, unknown>)['minRiskLast30d'] as number | null | undefined;
  if (sumMNR30 != null) console.log(`  Min risk 30d:       ${sumMNR30.toFixed(3)}`); // T1007
  const sumRRL24 = (s as Record<string, unknown>)['riskRangeLast24h'] as number | null | undefined;
  if (sumRRL24 != null) console.log(`  Risk range 24h:     ${sumRRL24.toFixed(3)}`); // T1008
  const sumRRL7 = (s as Record<string, unknown>)['riskRangeLast7d'] as number | null | undefined;
  if (sumRRL7 != null) console.log(`  Risk range 7d:      ${sumRRL7.toFixed(3)}`); // T1009
  const sumRRL30 = (s as Record<string, unknown>)['riskRangeLast30d'] as number | null | undefined;
  if (sumRRL30 != null) console.log(`  Risk range 30d:     ${sumRRL30.toFixed(3)}`); // T1010
  const sumP25_b = (s as Record<string, unknown>)['p25Risk'] as number | null | undefined;
  if (sumP25_b != null) console.log(`  P25 risk:           ${sumP25_b.toFixed(3)}`); // T1011
  const sumP75 = (s as Record<string, unknown>)['p75Risk'] as number | null | undefined;
  if (sumP75 != null) console.log(`  P75 risk:           ${sumP75.toFixed(3)}`); // T1012
  const sumIQR_b = (s as Record<string, unknown>)['iqrRisk'] as number | null | undefined;
  if (sumIQR_b != null) console.log(`  IQR risk:           ${sumIQR_b.toFixed(3)}`); // T1013
  const sumP95_b = (s as Record<string, unknown>)['p95Risk'] as number | null | undefined;
  if (sumP95_b != null) console.log(`  P95 risk:           ${sumP95_b.toFixed(3)}`); // T1014
  const sumP5 = (s as Record<string, unknown>)['p5Risk'] as number | null | undefined;
  if (sumP5 != null) console.log(`  P5 risk:            ${sumP5.toFixed(3)}`); // T1015
  const sumRSS = (s as Record<string, unknown>)['riskSkewnessSign'] as number | null | undefined;
  if (sumRSS != null) console.log(`  Risk skewness sign: ${sumRSS}`); // T1016
  const sumAPR30 = (s as Record<string, unknown>)['approvalRateLast30d'] as number | null | undefined;
  if (sumAPR30 != null) console.log(`  Approval rate 30d:  ${(sumAPR30 * 100).toFixed(1)}%`); // T1017
  const sumAPC30 = (s as Record<string, unknown>)['approvalCountLast30d'] as number | undefined;
  if (sumAPC30 != null && sumAPC30 > 0) console.log(`  Approvals 30d:      ${sumAPC30}`); // T1018
  const sumBC1h = (s as Record<string, unknown>)['blockCountLast1h'] as number | undefined;
  if (sumBC1h != null && sumBC1h > 0) console.log(`  Blocks last 1h:     ${sumBC1h}`); // T1019
  const sumAC1h = (s as Record<string, unknown>)['allowCountLast1h'] as number | undefined;
  if (sumAC1h != null && sumAC1h > 0) console.log(`  Allows last 1h:     ${sumAC1h}`); // T1020
  const sumAPC24_b = (s as Record<string, unknown>)['approvalCountLast24h'] as number | undefined;
  if (sumAPC24_b != null && sumAPC24_b > 0) console.log(`  Approvals 24h:      ${sumAPC24_b}`); // T1021
  const sumAPC7 = (s as Record<string, unknown>)['approvalCountLast7d'] as number | undefined;
  if (sumAPC7 != null && sumAPC7 > 0) console.log(`  Approvals 7d:       ${sumAPC7}`); // T1022
  const sumAPR24_b = (s as Record<string, unknown>)['approvalRateLast24h'] as number | null | undefined;
  if (sumAPR24_b != null) console.log(`  Approval rate 24h:  ${(sumAPR24_b * 100).toFixed(1)}%`); // T1023
  const sumAPR7 = (s as Record<string, unknown>)['approvalRateLast7d'] as number | null | undefined;
  if (sumAPR7 != null) console.log(`  Approval rate 7d:   ${(sumAPR7 * 100).toFixed(1)}%`); // T1024
  const sumBR1h = (s as Record<string, unknown>)['blockRateLast1h'] as number | null | undefined;
  if (sumBR1h != null) console.log(`  Block rate 1h:      ${(sumBR1h * 100).toFixed(1)}%`); // T1025
  const sumAR1h = (s as Record<string, unknown>)['allowRateLast1h'] as number | null | undefined;
  if (sumAR1h != null) console.log(`  Allow rate 1h:      ${(sumAR1h * 100).toFixed(1)}%`); // T1026
  const sumBR7 = (s as Record<string, unknown>)['blockRateLast7d'] as number | null | undefined;
  if (sumBR7 != null) console.log(`  Block rate 7d:      ${(sumBR7 * 100).toFixed(1)}%`); // T1027
  const sumAR7 = (s as Record<string, unknown>)['allowRateLast7d'] as number | null | undefined;
  if (sumAR7 != null) console.log(`  Allow rate 7d:      ${(sumAR7 * 100).toFixed(1)}%`); // T1028
  const sumBR30 = (s as Record<string, unknown>)['blockRateLast30d'] as number | null | undefined;
  if (sumBR30 != null) console.log(`  Block rate 30d:     ${(sumBR30 * 100).toFixed(1)}%`); // T1029
  const sumAR30 = (s as Record<string, unknown>)['allowRateLast30d'] as number | null | undefined;
  if (sumAR30 != null) console.log(`  Allow rate 30d:     ${(sumAR30 * 100).toFixed(1)}%`); // T1030
  const sumOC1h = (s as Record<string, unknown>)['opCountLast1h'] as number | undefined;
  if (sumOC1h != null && sumOC1h > 0) console.log(`  Ops last 1h:        ${sumOC1h}`); // T1031
  const sumOC24 = (s as Record<string, unknown>)['opCountLast24h'] as number | undefined;
  if (sumOC24 != null && sumOC24 > 0) console.log(`  Ops last 24h:       ${sumOC24}`); // T1032
  const sumOC7 = (s as Record<string, unknown>)['opCountLast7d'] as number | undefined;
  if (sumOC7 != null && sumOC7 > 0) console.log(`  Ops last 7d:        ${sumOC7}`); // T1033
  const sumOC30 = (s as Record<string, unknown>)['opCountLast30d'] as number | undefined;
  if (sumOC30 != null && sumOC30 > 0) console.log(`  Ops last 30d:       ${sumOC30}`); // T1034
  const sumBC24 = (s as Record<string, unknown>)['blockCountLast24h'] as number | undefined;
  if (sumBC24 != null && sumBC24 > 0) console.log(`  Blocks 24h:         ${sumBC24}`); // T1035
  const sumBC7 = (s as Record<string, unknown>)['blockCountLast7d'] as number | undefined;
  if (sumBC7 != null && sumBC7 > 0) console.log(`  Blocks 7d:          ${sumBC7}`); // T1036
  const sumBC30 = (s as Record<string, unknown>)['blockCountLast30d'] as number | undefined;
  if (sumBC30 != null && sumBC30 > 0) console.log(`  Blocks 30d:         ${sumBC30}`); // T1037
  const sumAC24 = (s as Record<string, unknown>)['allowCountLast24h'] as number | undefined;
  if (sumAC24 != null && sumAC24 > 0) console.log(`  Allows 24h:         ${sumAC24}`); // T1038
  const sumAC7 = (s as Record<string, unknown>)['allowCountLast7d'] as number | undefined;
  if (sumAC7 != null && sumAC7 > 0) console.log(`  Allows 7d:          ${sumAC7}`); // T1039
  const sumAC30 = (s as Record<string, unknown>)['allowCountLast30d'] as number | undefined;
  if (sumAC30 != null && sumAC30 > 0) console.log(`  Allows 30d:         ${sumAC30}`); // T1040
  const sumHRC24_b = (s as Record<string, unknown>)['highRiskCountLast24h'] as number | undefined;
  if (sumHRC24_b != null && sumHRC24_b > 0) console.log(`  High-risk 24h:      ${sumHRC24_b}`); // T1041
  const sumHRC7 = (s as Record<string, unknown>)['highRiskCountLast7d'] as number | undefined;
  if (sumHRC7 != null && sumHRC7 > 0) console.log(`  High-risk 7d:       ${sumHRC7}`); // T1042
  const sumHRC30 = (s as Record<string, unknown>)['highRiskCountLast30d'] as number | undefined;
  if (sumHRC30 != null && sumHRC30 > 0) console.log(`  High-risk 30d:      ${sumHRC30}`); // T1043
  const sumHRR24 = (s as Record<string, unknown>)['highRiskRateLast24h'] as number | null | undefined;
  if (sumHRR24 != null) console.log(`  High-risk rate 24h: ${(sumHRR24 * 100).toFixed(1)}%`); // T1044
  const sumHRR7 = (s as Record<string, unknown>)['highRiskRateLast7d'] as number | null | undefined;
  if (sumHRR7 != null) console.log(`  High-risk rate 7d:  ${(sumHRR7 * 100).toFixed(1)}%`); // T1045
  const sumHRR30 = (s as Record<string, unknown>)['highRiskRateLast30d'] as number | null | undefined;
  if (sumHRR30 != null) console.log(`  High-risk rate 30d: ${(sumHRR30 * 100).toFixed(1)}%`); // T1046
  const sumLRC24_b = (s as Record<string, unknown>)['lowRiskCountLast24h'] as number | undefined;
  if (sumLRC24_b != null && sumLRC24_b > 0) console.log(`  Low-risk 24h:       ${sumLRC24_b}`); // T1047
  const sumLRC7 = (s as Record<string, unknown>)['lowRiskCountLast7d'] as number | undefined;
  if (sumLRC7 != null && sumLRC7 > 0) console.log(`  Low-risk 7d:        ${sumLRC7}`); // T1048
  const sumLRC30 = (s as Record<string, unknown>)['lowRiskCountLast30d'] as number | undefined;
  if (sumLRC30 != null && sumLRC30 > 0) console.log(`  Low-risk 30d:       ${sumLRC30}`); // T1049
  const sumLRR24 = (s as Record<string, unknown>)['lowRiskRateLast24h'] as number | null | undefined;
  if (sumLRR24 != null) console.log(`  Low-risk rate 24h:  ${(sumLRR24 * 100).toFixed(1)}%`); // T1050
  const sumLRR7 = (s as Record<string, unknown>)['lowRiskRateLast7d'] as number | null | undefined;
  if (sumLRR7 != null) console.log(`  Low-risk rate 7d:   ${(sumLRR7 * 100).toFixed(1)}%`); // T1051
  const sumLRR30 = (s as Record<string, unknown>)['lowRiskRateLast30d'] as number | null | undefined;
  if (sumLRR30 != null) console.log(`  Low-risk rate 30d:  ${(sumLRR30 * 100).toFixed(1)}%`); // T1052
  const sumMRC24_b = (s as Record<string, unknown>)['medRiskCountLast24h'] as number | undefined;
  if (sumMRC24_b != null && sumMRC24_b > 0) console.log(`  Med-risk 24h:       ${sumMRC24_b}`); // T1053
  const sumMRC7 = (s as Record<string, unknown>)['medRiskCountLast7d'] as number | undefined;
  if (sumMRC7 != null && sumMRC7 > 0) console.log(`  Med-risk 7d:        ${sumMRC7}`); // T1054
  const sumMRC30 = (s as Record<string, unknown>)['medRiskCountLast30d'] as number | undefined;
  if (sumMRC30 != null && sumMRC30 > 0) console.log(`  Med-risk 30d:       ${sumMRC30}`); // T1055
  const sumMRR24 = (s as Record<string, unknown>)['medRiskRateLast24h'] as number | null | undefined;
  if (sumMRR24 != null) console.log(`  Med-risk rate 24h:  ${(sumMRR24 * 100).toFixed(1)}%`); // T1056
  const sumMRR7 = (s as Record<string, unknown>)['medRiskRateLast7d'] as number | null | undefined;
  if (sumMRR7 != null) console.log(`  Med-risk rate 7d:   ${(sumMRR7 * 100).toFixed(1)}%`); // T1057
  const sumMRR30 = (s as Record<string, unknown>)['medRiskRateLast30d'] as number | null | undefined;
  if (sumMRR30 != null) console.log(`  Med-risk rate 30d:  ${(sumMRR30 * 100).toFixed(1)}%`); // T1058
  const sumRV24_b = (s as Record<string, unknown>)['riskVarianceLast24h'] as number | null | undefined;
  if (sumRV24_b != null) console.log(`  Risk variance 24h:  ${sumRV24_b.toFixed(4)}`); // T1059
  const sumRV7 = (s as Record<string, unknown>)['riskVarianceLast7d'] as number | null | undefined;
  if (sumRV7 != null) console.log(`  Risk variance 7d:   ${sumRV7.toFixed(4)}`); // T1060
  const sumRSD24 = (s as Record<string, unknown>)['riskStdDevLast24h'] as number | null | undefined;
  if (sumRSD24 != null) console.log(`  Risk std dev 24h:   ${sumRSD24.toFixed(3)}`); // T1061
  const sumRSD7 = (s as Record<string, unknown>)['riskStdDevLast7d'] as number | null | undefined;
  if (sumRSD7 != null) console.log(`  Risk std dev 7d:    ${sumRSD7.toFixed(3)}`); // T1062
  const sumRSD30 = (s as Record<string, unknown>)['riskStdDevLast30d'] as number | null | undefined;
  if (sumRSD30 != null) console.log(`  Risk std dev 30d:   ${sumRSD30.toFixed(3)}`); // T1063
  const sumRVA30 = (s as Record<string, unknown>)['riskVarianceLast30d'] as number | null | undefined;
  if (sumRVA30 != null) console.log(`  Risk variance 30d:  ${sumRVA30.toFixed(4)}`); // T1064
  const sumAR1h_b = (s as Record<string, unknown>)['avgRiskLast1h'] as number | null | undefined;
  if (sumAR1h_b != null) console.log(`  Avg risk 1h:        ${sumAR1h_b.toFixed(3)}`); // T1065
  const sumAR24 = (s as Record<string, unknown>)['avgRiskLast24h'] as number | null | undefined;
  if (sumAR24 != null) console.log(`  Avg risk 24h:       ${sumAR24.toFixed(3)}`); // T1066
  const sumAR7_b = (s as Record<string, unknown>)['avgRiskLast7d'] as number | null | undefined;
  if (sumAR7_b != null) console.log(`  Avg risk 7d:        ${sumAR7_b.toFixed(3)}`); // T1067
  const sumAR30_b = (s as Record<string, unknown>)['avgRiskLast30d'] as number | null | undefined;
  if (sumAR30_b != null) console.log(`  Avg risk 30d:       ${sumAR30_b.toFixed(3)}`); // T1068
  const sumART1h = (s as Record<string, unknown>)['avgRiskTrend1hVs24h'] as number | null | undefined;
  if (sumART1h != null) console.log(`  Avg risk trend 1h>24h: ${sumART1h.toFixed(3)}`); // T1069
  const sumART24 = (s as Record<string, unknown>)['avgRiskTrend24hVs7d'] as number | null | undefined;
  if (sumART24 != null) console.log(`  Avg risk trend 24h>7d: ${sumART24.toFixed(3)}`); // T1070
  const sumART7 = (s as Record<string, unknown>)['avgRiskTrend7dVs30d'] as number | null | undefined;
  if (sumART7 != null) console.log(`  Avg risk trend 7d>30d: ${sumART7.toFixed(3)}`); // T1071
  const sumMXR_b = (s as Record<string, unknown>)['maxRiskAllTime'] as number | null | undefined;
  if (sumMXR_b != null) console.log(`  Max risk all-time:     ${sumMXR_b.toFixed(3)}`); // T1072
  const sumMNR_b = (s as Record<string, unknown>)['minRiskAllTime'] as number | null | undefined;
  if (sumMNR_b != null) console.log(`  Min risk all-time:     ${sumMNR_b.toFixed(3)}`); // T1073
  const sumOCT1 = (s as Record<string, unknown>)['opCountTrend1hVs24h'] as number | null | undefined;
  if (sumOCT1 != null) console.log(`  Op count trend 1h>24h: ${sumOCT1.toFixed(2)}`); // T1074
  const sumOCT24 = (s as Record<string, unknown>)['opCountTrend24hVs7d'] as number | null | undefined;
  if (sumOCT24 != null) console.log(`  Op count trend 24h>7d: ${sumOCT24.toFixed(2)}`); // T1075
  const sumBCT_b = (s as Record<string, unknown>)['blockCountTrend1hVs24h'] as number | null | undefined;
  if (sumBCT_b != null) console.log(`  Block count trend 1h>24h: ${sumBCT_b.toFixed(2)}`); // T1076
  const sumACT_b = (s as Record<string, unknown>)['allowCountTrend1hVs24h'] as number | null | undefined;
  if (sumACT_b != null) console.log(`  Allow count trend 1h>24h: ${sumACT_b.toFixed(2)}`); // T1077
  const sumAPCT = (s as Record<string, unknown>)['approvalCountTrend1hVs24h'] as number | null | undefined;
  if (sumAPCT != null) console.log(`  Approval count trend 1h>24h: ${sumAPCT.toFixed(2)}`); // T1078
  const sumBCT24 = (s as Record<string, unknown>)['blockCountTrend24hVs7d'] as number | null | undefined;
  if (sumBCT24 != null) console.log(`  Block count trend 24h>7d:  ${sumBCT24.toFixed(2)}`); // T1079
  const sumACT24 = (s as Record<string, unknown>)['allowCountTrend24hVs7d'] as number | null | undefined;
  if (sumACT24 != null) console.log(`  Allow count trend 24h>7d:  ${sumACT24.toFixed(2)}`); // T1080
  const sumAPCT24 = (s as Record<string, unknown>)['approvalCountTrend24hVs7d'] as number | null | undefined;
  if (sumAPCT24 != null) console.log(`  Approval count trend 24h>7d: ${sumAPCT24.toFixed(2)}`); // T1081
  const sumBCT7 = (s as Record<string, unknown>)['blockCountTrend7dVs30d'] as number | null | undefined;
  if (sumBCT7 != null) console.log(`  Block count trend 7d>30d:  ${sumBCT7.toFixed(2)}`); // T1082
  const sumACT7 = (s as Record<string, unknown>)['allowCountTrend7dVs30d'] as number | null | undefined;
  if (sumACT7 != null) console.log(`  Allow count trend 7d>30d:  ${sumACT7.toFixed(2)}`); // T1083
  const sumAPCT7 = (s as Record<string, unknown>)['approvalCountTrend7dVs30d'] as number | null | undefined;
  if (sumAPCT7 != null) console.log(`  Approval count trend 7d>30d: ${sumAPCT7.toFixed(2)}`); // T1084
  const sumRRA = (s as Record<string, unknown>)['riskRangeAllTime'] as number | null | undefined;
  if (sumRRA != null) console.log(`  Risk range all-time:   ${sumRRA.toFixed(3)}`); // T1085
  const sumRP25 = (s as Record<string, unknown>)['riskP25'] as number | null | undefined;
  if (sumRP25 != null) console.log(`  Risk P25:              ${sumRP25.toFixed(3)}`); // T1086
  const sumRP75 = (s as Record<string, unknown>)['riskP75'] as number | null | undefined;
  if (sumRP75 != null) console.log(`  Risk P75:              ${sumRP75.toFixed(3)}`); // T1087
  const sumRIQR_c = (s as Record<string, unknown>)['riskIQR'] as number | null | undefined;
  if (sumRIQR_c != null) console.log(`  Risk IQR:              ${sumRIQR_c.toFixed(3)}`); // T1088
  const sumRP25h24 = (s as Record<string, unknown>)['riskP25Last24h'] as number | null | undefined;
  if (sumRP25h24 != null) console.log(`  Risk P25 24h:          ${sumRP25h24.toFixed(3)}`); // T1089
  const sumRP75h24 = (s as Record<string, unknown>)['riskP75Last24h'] as number | null | undefined;
  if (sumRP75h24 != null) console.log(`  Risk P75 24h:          ${sumRP75h24.toFixed(3)}`); // T1090
  const sumRIQRh24 = (s as Record<string, unknown>)['riskIQRLast24h'] as number | null | undefined;
  if (sumRIQRh24 != null) console.log(`  Risk IQR 24h:          ${sumRIQRh24.toFixed(3)}`); // T1091
  const sumRP25d7 = (s as Record<string, unknown>)['riskP25Last7d'] as number | null | undefined;
  if (sumRP25d7 != null) console.log(`  Risk P25 7d:           ${sumRP25d7.toFixed(3)}`); // T1092
  const sumRP75d7 = (s as Record<string, unknown>)['riskP75Last7d'] as number | null | undefined;
  if (sumRP75d7 != null) console.log(`  Risk P75 7d:           ${sumRP75d7.toFixed(3)}`); // T1093
  const sumRIQRd7 = (s as Record<string, unknown>)['riskIQRLast7d'] as number | null | undefined;
  if (sumRIQRd7 != null) console.log(`  Risk IQR 7d:           ${sumRIQRd7.toFixed(3)}`); // T1094
  const sumRP25d30 = (s as Record<string, unknown>)['riskP25Last30d'] as number | null | undefined;
  if (sumRP25d30 != null) console.log(`  Risk P25 30d:          ${sumRP25d30.toFixed(3)}`); // T1095
  const sumRP75d30 = (s as Record<string, unknown>)['riskP75Last30d'] as number | null | undefined;
  if (sumRP75d30 != null) console.log(`  Risk P75 30d:          ${sumRP75d30.toFixed(3)}`); // T1096
  const sumRIQRd30 = (s as Record<string, unknown>)['riskIQRLast30d'] as number | null | undefined;
  if (sumRIQRd30 != null) console.log(`  Risk IQR 30d:          ${sumRIQRd30.toFixed(3)}`); // T1097
  const sumRP10 = (s as Record<string, unknown>)['riskP10'] as number | null | undefined;
  if (sumRP10 != null) console.log(`  Risk P10:              ${sumRP10.toFixed(3)}`); // T1098
  const sumRHR = (s as Record<string, unknown>)['recentHighRiskOps'] as Array<Record<string, unknown>> | undefined;
  if (sumRHR && sumRHR.length > 0) { // T613
    console.log(`\nRecent High Risk Ops (${sumRHR.length}):`);
    for (const op of sumRHR) console.log(`  ${op['agentId']}.${op['tool']} risk=${((op['riskScore'] as number) * 100).toFixed(0)}% [${op['action']}]`);
  }
}
