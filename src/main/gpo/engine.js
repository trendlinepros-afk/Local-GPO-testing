'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../util/exec');
const store = require('./store');

// ---------------------------------------------------------------------------
// The engine is the only place that touches the real system. Everything is
// funnelled through readCurrent / applyChanges / runGpupdate so the rest of the
// app is identical on Windows and in simulation mode.
// ---------------------------------------------------------------------------

function isWindows() {
  return process.platform === 'win32';
}

function isSimulation() {
  if (process.env.GPO_SIMULATE === '1') return true;
  if (process.env.GPO_SIMULATE === '0') return false;
  return !isWindows();
}

function cleanup(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {
    /* ignore */
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function checkAdmin() {
  if (isSimulation()) return true;
  const res = await run('net session');
  return res.code === 0;
}

async function platformInfo() {
  return {
    platform: process.platform,
    release: os.release(),
    hostname: os.hostname(),
    simulation: isSimulation(),
    admin: await checkAdmin()
  };
}

// ---- secedit (Local Security Policy) --------------------------------------

function parseInf(text) {
  const out = {};
  let cur = null;
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      cur = sec[1];
      out[cur] = out[cur] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || !cur) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[cur][key] = val;
  }
  return out;
}

async function exportSeceditPolicy() {
  const tmp = path.join(os.tmpdir(), `gpo-export-${Date.now()}.inf`);
  const res = await run(`secedit /export /cfg "${tmp}" /areas SECURITYPOLICY /quiet`);
  let parsed = {};
  if (res.code === 0 && fs.existsSync(tmp)) {
    try {
      parsed = parseInf(fs.readFileSync(tmp, 'ucs2'));
    } catch (_) {
      parsed = {};
    }
  }
  cleanup(tmp);
  return parsed;
}

function readSeceditValue(setting, cache) {
  const section = cache[setting.section];
  if (!section) return null;
  const key = Object.keys(section).find((k) => k.toLowerCase() === setting.key.toLowerCase());
  return key ? section[key] : null;
}

async function applySeceditBatch(list) {
  const usable = list.filter((c) => c.value !== null && c.value !== undefined && c.value !== '');
  const skipped = list.filter((c) => !(c.value !== null && c.value !== undefined && c.value !== ''));

  if (!usable.length) {
    return {
      ok: skipped.length === 0,
      message: skipped.length
        ? 'A security-policy value cannot be unset via secedit; left unchanged.'
        : 'No security-policy changes.',
      skippedIds: skipped.map((c) => c.id)
    };
  }

  const sections = {};
  for (const c of usable) {
    const sec = c.setting.section;
    (sections[sec] = sections[sec] || []).push(`${c.setting.key} = ${c.value}`);
  }

  let inf = '[Unicode]\r\nUnicode=yes\r\n[Version]\r\nsignature="$CHICAGO$"\r\nRevision=1\r\n';
  for (const sec of Object.keys(sections)) {
    inf += `[${sec}]\r\n${sections[sec].join('\r\n')}\r\n`;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const infPath = path.join(os.tmpdir(), `gpo-apply-${stamp}.inf`);
  const dbPath = path.join(os.tmpdir(), `gpo-apply-${stamp}.sdb`);
  fs.writeFileSync(infPath, '﻿' + inf, 'ucs2');

  const res = await run(
    `secedit /configure /db "${dbPath}" /cfg "${infPath}" /areas SECURITYPOLICY /overwrite /quiet`
  );
  cleanup(infPath);
  cleanup(dbPath);

  const ok = res.code === 0;
  return {
    ok,
    message: ok ? 'Applied via secedit.' : res.stderr || res.stdout || 'secedit failed.',
    skippedIds: skipped.map((c) => c.id)
  };
}

// ---- Registry --------------------------------------------------------------

async function readRegistryValue(setting) {
  const key = `${setting.hive}\\${setting.path}`;
  const res = await run(`reg query "${key}" /v "${setting.value}"`);
  if (res.code !== 0) return null;
  const re = new RegExp(escapeRegExp(setting.value) + '\\s+REG_\\w+\\s+(\\S+)', 'i');
  const m = res.stdout.match(re);
  if (!m) return null;
  let data = m[1];
  if (/^0x[0-9a-f]+$/i.test(data)) data = String(parseInt(data, 16));
  return data;
}

async function applyRegistry(setting, value) {
  const key = `${setting.hive}\\${setting.path}`;
  if (value === null || value === undefined || value === '') {
    const res = await run(`reg delete "${key}" /v "${setting.value}" /f`);
    const notThere = /unable to find|cannot find|specified registry key/i.test(res.stdout + res.stderr);
    return { ok: res.code === 0 || notThere, message: res.stderr || res.stdout || 'Value removed.' };
  }
  const type = setting.regType || 'REG_DWORD';
  const res = await run(`reg add "${key}" /v "${setting.value}" /t ${type} /d ${value} /f`);
  return { ok: res.code === 0, message: res.stderr || res.stdout || 'Applied via registry.' };
}

// ---- Public read / apply ---------------------------------------------------

async function readAllCurrent(settings, ids) {
  const result = {};
  if (isSimulation()) {
    for (const id of ids) result[id] = store.getSimCurrent(id);
    return result;
  }
  const needSecedit = ids.some((id) => settings[id] && settings[id].type === 'secedit');
  const cache = needSecedit ? await exportSeceditPolicy() : {};
  for (const id of ids) {
    const s = settings[id];
    if (!s) {
      result[id] = null;
      continue;
    }
    result[id] = s.type === 'secedit' ? readSeceditValue(s, cache) : await readRegistryValue(s);
  }
  return result;
}

/**
 * changes: [{ id, setting, value }]  (value may be null to unset)
 * Returns [{ id, ok, method, message }]
 */
async function applyChanges(changes) {
  const results = [];

  if (isSimulation()) {
    for (const c of changes) {
      store.setSimCurrent(c.id, c.value);
      results.push({ id: c.id, ok: true, method: 'simulation', message: 'Applied (simulation).' });
    }
    return results;
  }

  const secedit = changes.filter((c) => c.setting.type === 'secedit');
  const registry = changes.filter((c) => c.setting.type === 'registry');

  if (secedit.length) {
    const batch = await applySeceditBatch(secedit);
    for (const c of secedit) {
      const skipped = batch.skippedIds.includes(c.id);
      results.push({
        id: c.id,
        ok: skipped ? false : batch.ok,
        method: 'secedit',
        message: skipped ? 'Skipped: cannot unset via secedit.' : batch.message
      });
    }
  }

  for (const c of registry) {
    const r = await applyRegistry(c.setting, c.value);
    results.push({ id: c.id, ok: r.ok, method: 'registry', message: r.message });
  }

  return results;
}

async function runGpupdate() {
  if (isSimulation()) {
    return { code: 0, ok: true, output: 'Simulation: gpupdate /force not run on this platform.', simulated: true };
  }
  const res = await run('gpupdate /force', { timeout: 180000 });
  return {
    code: res.code,
    ok: res.code === 0,
    output: (res.stdout || '') + (res.stderr || ''),
    simulated: false
  };
}

// ---- Scanning --------------------------------------------------------------

function tryParseJson(text) {
  const t = (text || '').trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return null;
  }
}

async function scanServicesSc() {
  const res = await run('sc query type= service state= active');
  if (res.code !== 0) return [];
  const services = [];
  let cur = null;
  for (const raw of res.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const nameM = line.match(/^SERVICE_NAME:\s*(.+)$/i);
    const dispM = line.match(/^DISPLAY_NAME:\s*(.+)$/i);
    if (nameM) {
      cur = { name: nameM[1].trim(), displayName: nameM[1].trim(), state: 'Running' };
      services.push(cur);
    } else if (dispM && cur) {
      cur.displayName = dispM[1].trim();
    }
  }
  return services;
}

async function scanServices() {
  if (isSimulation()) return store.SIM_SERVICES.slice();
  const ps =
    "Get-CimInstance Win32_Service | Where-Object {$_.State -eq 'Running'} | " +
    'Select-Object Name,DisplayName,State | ConvertTo-Json -Compress';
  const res = await run(
    `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${ps}"`
  );
  const parsed = tryParseJson(res.stdout);
  if (parsed) {
    return parsed
      .filter((s) => s && s.Name)
      .map((s) => ({ name: s.Name, displayName: s.DisplayName || s.Name, state: s.State || 'Running' }));
  }
  return scanServicesSc();
}

async function scanProcesses() {
  if (isSimulation()) return store.SIM_PROCESSES.slice();
  const res = await run('tasklist /fo csv /nh');
  if (res.code !== 0) return [];
  const procs = [];
  const seen = new Set();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    procs.push({ name, pid: parseInt(m[2], 10) });
  }
  return procs;
}

module.exports = {
  isWindows,
  isSimulation,
  checkAdmin,
  platformInfo,
  readAllCurrent,
  applyChanges,
  runGpupdate,
  scanServices,
  scanProcesses
};
