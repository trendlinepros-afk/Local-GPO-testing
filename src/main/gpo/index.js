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
  let changesCount = 0;

  for (const r of resolved) {
    const cur = normalize(current[r.id]);
    const des = normalize(r.desired);
    if (cur === des) continue; // already compliant — nothing would change
    changesCount += 1;

    const def = r.def;
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
        method: res.method,
        ok: res.ok,
        message: res.message,
        reverted: false,
        revertedAt: null
      };
    })
  };

  store.addBatch(batch);
  return { applied: true, batch, gpupdate, results };
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

module.exports = {
  listBaselines,
  getComparison,
  scan,
  apply,
  getBatches,
  revert,
  platformInfo: engine.platformInfo
};
