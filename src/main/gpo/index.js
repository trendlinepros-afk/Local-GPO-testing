'use strict';

const engine = require('./engine');
const store = require('./store');
const { formatValue, normalize } = require('./format');

const catalog = require('../../data/catalog.json');
const baselines = [
  require('../../data/baselines/nist.json'),
  require('../../data/baselines/cmmc-l2.json'),
  require('../../data/baselines/hipaa.json'),
  require('../../data/baselines/soc2.json')
];

const SETTINGS = catalog.settings;
const RISK_ORDER = { low: 1, medium: 2, high: 3 };

function baselineById(id) {
  return baselines.find((b) => b.id === id);
}

function resolveSettings(baseline) {
  const rows = [];
  for (const id of Object.keys(baseline.settings)) {
    const def = SETTINGS[id];
    if (!def) continue;
    rows.push({ id, def, desired: String(baseline.settings[id].desired) });
  }
  return rows;
}

function maxRisk(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function wildcardToRegExp(pattern) {
  const esc = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

function matchPatterns(patterns, values) {
  const concrete = (patterns || []).filter((p) => p !== '*');
  if (!concrete.length) return false;
  const regs = concrete.map(wildcardToRegExp);
  return values.some((v) => v && regs.some((r) => r.test(v)));
}

// ---- Public API ------------------------------------------------------------

function listBaselines() {
  return baselines.map((b) => ({
    id: b.id,
    shortName: b.shortName,
    name: b.name,
    description: b.description,
    reference: b.reference,
    settingCount: Object.keys(b.settings).length
  }));
}

async function getComparison(standardId) {
  const baseline = baselineById(standardId);
  if (!baseline) throw new Error(`Unknown compliance standard: ${standardId}`);

  const resolved = resolveSettings(baseline);
  const ids = resolved.map((r) => r.id);
  const current = await engine.readAllCurrent(SETTINGS, ids);

  const rows = resolved.map((r) => {
    const cur = normalize(current[r.id]);
    const des = normalize(r.desired);
    return {
      id: r.id,
      name: r.def.name,
      category: r.def.category,
      description: r.def.description,
      type: r.def.type,
      current: cur,
      currentDisplay: formatValue(cur, r.def),
      desired: des,
      desiredDisplay: formatValue(des, r.def),
      differs: cur !== des,
      reboot: !!r.def.reboot,
      generalImpact: r.def.generalImpact || null
    };
  });

  const differing = rows.filter((r) => r.differs).length;
  return {
    standard: {
      id: baseline.id,
      shortName: baseline.shortName,
      name: baseline.name,
      description: baseline.description,
      reference: baseline.reference
    },
    rows,
    summary: { total: rows.length, differing, compliant: rows.length - differing }
  };
}

async function scan(standardId) {
  const baseline = baselineById(standardId);
  if (!baseline) throw new Error(`Unknown compliance standard: ${standardId}`);

  const resolved = resolveSettings(baseline);
  const ids = resolved.map((r) => r.id);

  const [current, services, processes, platform] = await Promise.all([
    engine.readAllCurrent(SETTINGS, ids),
    engine.scanServices(),
    engine.scanProcesses(),
    engine.platformInfo()
  ]);

  const issues = [];
  const byRisk = { high: 0, medium: 0, low: 0 };
  const rebootRequired = [];
  let changesCount = 0;

  for (const r of resolved) {
    const cur = normalize(current[r.id]);
    const des = normalize(r.desired);
    if (cur === des) continue; // already compliant — nothing would change
    changesCount += 1;

    const def = r.def;
    if (def.reboot) rebootRequired.push(def.name);
    const reasons = [];
    const matchedServices = [];
    const matchedProcesses = [];
    let ruleRisk = null;

    for (const rule of def.serviceImpacts || []) {
      const svcPatterns = rule.services || [];
      const procPatterns = rule.processes || [];
      const svcBroad = svcPatterns.includes('*');
      const procBroad = procPatterns.includes('*');

      const svcHits = svcBroad
        ? []
        : services.filter((s) => matchPatterns(svcPatterns, [s.name, s.displayName]));
      const procHits = procBroad ? [] : processes.filter((p) => matchPatterns(procPatterns, [p.name]));

      const broadHit = (svcBroad && services.length) || (procBroad && processes.length);
      if (svcHits.length || procHits.length || broadHit) {
        reasons.push(rule.detail);
        ruleRisk = maxRisk(ruleRisk, rule.risk);
        for (const s of svcHits) {
          if (!matchedServices.find((m) => m.name === s.name)) {
            matchedServices.push({ name: s.name, displayName: s.displayName });
          }
        }
        for (const p of procHits) {
          if (!matchedProcesses.includes(p.name)) matchedProcesses.push(p.name);
        }
      }
    }

    const general = def.generalImpact || null;
    const hasServiceEvidence = reasons.length > 0;
    const generalIsRisky = general && (general.risk === 'medium' || general.risk === 'high');

    if (!hasServiceEvidence && !generalIsRisky) continue; // low-risk, no evidence — omit from findings

    const risk = maxRisk(ruleRisk, general ? general.risk : null) || 'low';
    byRisk[risk] += 1;

    issues.push({
      settingId: r.id,
      name: def.name,
      category: def.category,
      risk,
      reboot: !!def.reboot,
      currentDisplay: formatValue(cur, def),
      desiredDisplay: formatValue(des, def),
      matchedServices,
      matchedProcesses,
      reasons,
      generalNote: general ? general.detail : null,
      serviceEvidence: hasServiceEvidence
    });
  }

  issues.sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk]);

  return {
    standard: { id: baseline.id, shortName: baseline.shortName, name: baseline.name },
    platform,
    servicesCount: services.length,
    processesCount: processes.length,
    changesCount,
    issues,
    byRisk,
    rebootRequired,
    services,
    processes
  };
}

async function apply(standardId, settingIds) {
  const baseline = baselineById(standardId);
  if (!baseline) throw new Error(`Unknown compliance standard: ${standardId}`);
  if (!Array.isArray(settingIds) || !settingIds.length) {
    throw new Error('No settings were selected to apply.');
  }

  const wanted = settingIds.filter((id) => SETTINGS[id] && baseline.settings[id]);
  const current = await engine.readAllCurrent(SETTINGS, wanted);

  const changeSpecs = [];
  for (const id of wanted) {
    const def = SETTINGS[id];
    const oldValue = normalize(current[id]);
    const newValue = normalize(String(baseline.settings[id].desired));
    if (oldValue === newValue) continue; // already at target
    changeSpecs.push({ id, setting: def, value: newValue, oldValue });
  }

  if (!changeSpecs.length) {
    return { applied: false, message: 'All selected settings already match the baseline.', batch: null, gpupdate: null };
  }

  const results = await engine.applyChanges(
    changeSpecs.map((c) => ({ id: c.id, setting: c.setting, value: c.value }))
  );
  const resultById = Object.fromEntries(results.map((r) => [r.id, r]));

  const gpupdate = await engine.runGpupdate();

  const batch = {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    standardId: baseline.id,
    standardName: baseline.name,
    standardShort: baseline.shortName,
    status: 'applied',
    gpupdate: { ok: gpupdate.ok, code: gpupdate.code, simulated: gpupdate.simulated },
    changes: changeSpecs.map((c) => {
      const res = resultById[c.id] || { ok: false, method: 'unknown', message: 'No result' };
      return {
        settingId: c.id,
        name: c.setting.name,
        category: c.setting.category,
        type: c.setting.type,
        oldValue: c.oldValue,
        newValue: c.value,
        oldDisplay: formatValue(c.oldValue, c.setting),
        newDisplay: formatValue(c.value, c.setting),
        reboot: !!c.setting.reboot,
        method: res.method,
        ok: res.ok,
        message: res.message,
        reverted: false,
        revertedAt: null
      };
    })
  };

  store.addBatch(batch);
  const rebootRequired = batch.changes.filter((c) => c.ok && c.reboot).map((c) => c.name);
  return { applied: true, batch, gpupdate, results, rebootRequired };
}

function getBatches() {
  return store.getBatches().slice().reverse(); // newest first
}

async function revert(options = {}) {
  const { mode, batchId, settingId, items } = options;
  const batches = store.getBatches();

  const targets = []; // { batch, change }
  const collect = (batch, change) => {
    if (!change || change.reverted || !change.ok) return;
    if (targets.find((t) => t.change === change)) return;
    targets.push({ batch, change });
  };

  if (mode === 'all') {
    for (const b of batches) for (const c of b.changes) collect(b, c);
  } else if (mode === 'batch') {
    const b = batches.find((x) => x.id === batchId);
    if (!b) throw new Error('Batch not found.');
    for (const c of b.changes) collect(b, c);
  } else if (mode === 'item') {
    const b = batches.find((x) => x.id === batchId);
    if (!b) throw new Error('Batch not found.');
    const c = b.changes.find((x) => x.settingId === settingId);
    if (!c) throw new Error('Change not found.');
    collect(b, c);
  } else if (mode === 'items') {
    for (const it of items || []) {
      const b = batches.find((x) => x.id === it.batchId);
      if (!b) continue;
      collect(b, b.changes.find((c) => c.settingId === it.settingId));
    }
  } else {
    throw new Error(`Unknown revert mode: ${mode}`);
  }

  if (!targets.length) {
    return { reverted: false, message: 'Nothing to revert.', results: [], gpupdate: null, batches: getBatches() };
  }

  // Revert most-recent first so overlapping settings land on their oldest prior value.
  targets.reverse();

  const changeList = targets.map((t) => ({
    id: t.change.settingId,
    setting: SETTINGS[t.change.settingId],
    value: t.change.oldValue // may be null -> unset/delete
  }));

  const results = await engine.applyChanges(changeList);
  const resultById = Object.fromEntries(results.map((r) => [r.id, r]));
  const gpupdate = await engine.runGpupdate();

  const nowIso = new Date().toISOString();
  for (const t of targets) {
    const res = resultById[t.change.settingId];
    if (res && res.ok) {
      t.change.reverted = true;
      t.change.revertedAt = nowIso;
    }
  }

  for (const b of batches) {
    const total = b.changes.filter((c) => c.ok).length;
    const done = b.changes.filter((c) => c.ok && c.reverted).length;
    if (done === 0) b.status = 'applied';
    else if (done >= total) b.status = 'reverted';
    else b.status = 'partially-reverted';
  }

  store.saveBatches(batches);

  return {
    reverted: true,
    results,
    gpupdate,
    batches: getBatches()
  };
}

// ---- Report -----------------------------------------------------------------

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildReport(standardId) {
  const [comparison, scanResult] = await Promise.all([getComparison(standardId), scan(standardId)]);
  const std = comparison.standard;
  const now = new Date();
  const p = scanResult.platform;

  const riskColor = { high: '#c0392b', medium: '#b7791f', low: '#2f855a' };

  const issueRows = scanResult.issues
    .map(
      (i) => `<tr>
        <td><span class="pill" style="background:${riskColor[i.risk]}">${esc(i.risk.toUpperCase())}</span></td>
        <td><strong>${esc(i.name)}</strong><div class="muted">${esc(i.category)}</div></td>
        <td>${esc(i.currentDisplay)} &rarr; <strong>${esc(i.desiredDisplay)}</strong>${i.reboot ? ' <span class="reboot">restart</span>' : ''}</td>
        <td>${(i.reasons && i.reasons.length ? i.reasons : [i.generalNote]).filter(Boolean).map(esc).join('<br>')}${
        i.matchedServices && i.matchedServices.length
          ? '<div class="muted">Detected: ' + i.matchedServices.map((s) => esc(s.displayName)).join(', ') + '</div>'
          : ''
      }</td>
      </tr>`
    )
    .join('');

  const cmpRows = comparison.rows
    .map(
      (r) => `<tr class="${r.differs ? 'diff' : 'same'}">
        <td>${r.differs ? '✕' : '✓'}</td>
        <td><strong>${esc(r.name)}</strong><div class="muted">${esc(r.category)}</div></td>
        <td>${esc(r.currentDisplay)}</td>
        <td><strong>${esc(r.desiredDisplay)}</strong>${r.reboot ? ' <span class="reboot">restart</span>' : ''}</td>
      </tr>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(std.shortName)} compliance report</title>
<style>
  body{font-family:Segoe UI,system-ui,Arial,sans-serif;margin:32px;color:#1a202c;background:#fff}
  h1{margin:0 0 4px}h2{margin-top:32px;border-bottom:2px solid #e2e8f0;padding-bottom:6px}
  .muted{color:#718096;font-size:12px}
  .meta{color:#4a5568;font-size:13px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}
  th,td{border:1px solid #e2e8f0;padding:8px 10px;text-align:left;vertical-align:top}
  th{background:#f7fafc;text-transform:uppercase;font-size:11px;letter-spacing:.4px;color:#4a5568}
  .pill{color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px}
  .reboot{color:#b7791f;font-size:10px;border:1px solid #b7791f;border-radius:4px;padding:0 4px}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
  .card{border:1px solid #e2e8f0;border-radius:8px;padding:10px 16px;min-width:110px}
  .card .n{font-size:22px;font-weight:800}.card .l{font-size:11px;color:#718096;text-transform:uppercase}
  tr.diff td:first-child{color:#c0392b;font-weight:700}tr.same td:first-child{color:#2f855a;font-weight:700}
  .note{background:#fffaf0;border:1px solid #f6e05e;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px}
</style></head><body>
<h1>${esc(std.name)}</h1>
<div class="meta">Local GPO Compliance Report &middot; Generated ${esc(now.toLocaleString())} &middot;
  Host: ${esc(p.hostname)} (${esc(p.platform)}${p.simulation ? ', simulation' : ''})</div>
<p>${esc(std.description)}</p>

<div class="cards">
  <div class="card"><div class="n">${comparison.summary.differing}</div><div class="l">Would change</div></div>
  <div class="card"><div class="n">${comparison.summary.compliant}</div><div class="l">Already compliant</div></div>
  <div class="card"><div class="n" style="color:${riskColor.high}">${scanResult.byRisk.high}</div><div class="l">High risk</div></div>
  <div class="card"><div class="n" style="color:${riskColor.medium}">${scanResult.byRisk.medium}</div><div class="l">Medium risk</div></div>
  <div class="card"><div class="n" style="color:${riskColor.low}">${scanResult.byRisk.low}</div><div class="l">Low risk</div></div>
  <div class="card"><div class="n">${scanResult.servicesCount}</div><div class="l">Services scanned</div></div>
</div>
${
  scanResult.rebootRequired && scanResult.rebootRequired.length
    ? `<div class="note">⟳ A restart is required to fully apply: ${scanResult.rebootRequired.map(esc).join(', ')}.</div>`
    : ''
}

<h2>Predicted impact (${scanResult.issues.length})</h2>
<table><thead><tr><th>Risk</th><th>Setting</th><th>Change</th><th>Why it may break</th></tr></thead>
<tbody>${issueRows || '<tr><td colspan="4">No likely breakage detected.</td></tr>'}</tbody></table>

<h2>Full comparison (${comparison.rows.length} settings)</h2>
<table><thead><tr><th>Δ</th><th>Setting</th><th>Current value</th><th>Baseline value</th></tr></thead>
<tbody>${cmpRows}</tbody></table>
</body></html>`;

  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return { html, filename: `GPO-compliance-${std.shortName.replace(/\s+/g, '')}-${stamp}.html` };
}

module.exports = {
  listBaselines,
  getComparison,
  scan,
  apply,
  getBatches,
  revert,
  buildReport,
  platformInfo: engine.platformInfo
};
