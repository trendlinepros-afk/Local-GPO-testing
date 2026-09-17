'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// ---------------------------------------------------------------------------
// On-disk persistence for change batches (used by the Revert feature) and, on
// non-Windows / forced-simulation runs, a mock "current policy" so the whole
// UI flow is usable without a live Local Group Policy store.
// ---------------------------------------------------------------------------

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return dir;
}

function batchesFile() {
  return path.join(dataDir(), 'batches.json');
}

function simFile() {
  return path.join(dataDir(), 'sim-state.json');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

// ---- Change batches --------------------------------------------------------

function getBatches() {
  const arr = readJson(batchesFile(), []);
  return Array.isArray(arr) ? arr : [];
}

function saveBatches(batches) {
  writeJson(batchesFile(), batches);
}

function addBatch(batch) {
  const batches = getBatches();
  batches.push(batch);
  saveBatches(batches);
  return batch;
}

// ---- Simulation state ------------------------------------------------------

// Deliberately "un-hardened" starting values so a demo run surfaces plenty of
// differences and scan findings.
const SIM_SEED = {
  PasswordMinLength: '7',
  PasswordComplexity: '0',
  MaxPasswordAge: '0',
  MinPasswordAge: '0',
  PasswordHistorySize: '0',
  ClearTextPassword: '0',
  LockoutThreshold: '0',
  LockoutDuration: '30',
  ResetLockoutCounter: '30',
  GuestAccountDisabled: '1',
  LimitBlankPasswordUse: '1',
  NoLMHash: '1',
  LmCompatibilityLevel: '3',
  RestrictAnonymousSAM: '1',
  InactivityTimeoutSecs: '0',
  UacEnableLUA: '1',
  UacAdminPrompt: '5',
  SmbV1Server: '1',
  RdpRequireNla: '0',
  RdpMinEncryption: '2',
  FirewallDomainEnable: '1',
  FirewallStandardEnable: '1',
  FirewallPublicEnable: '1',
  DisableAutoRun: '0',
  PsScriptBlockLogging: '0',
  AuditLogon: '0',
  AuditAccountLogon: '0',
  AuditAccountManage: '0',
  AuditPolicyChange: '0',
  AuditPrivilegeUse: '0',
  AuditObjectAccess: '0',
  AuditSystemEvents: '0'
};

const SIM_SERVICES = [
  { name: 'LanmanServer', displayName: 'Server', state: 'Running' },
  { name: 'LanmanWorkstation', displayName: 'Workstation', state: 'Running' },
  { name: 'TermService', displayName: 'Remote Desktop Services', state: 'Running' },
  { name: 'Spooler', displayName: 'Print Spooler', state: 'Running' },
  { name: 'MSSQLSERVER', displayName: 'SQL Server (MSSQLSERVER)', state: 'Running' },
  { name: 'W3SVC', displayName: 'World Wide Web Publishing Service', state: 'Running' },
  { name: 'Dnscache', displayName: 'DNS Client', state: 'Running' },
  { name: 'Dhcp', displayName: 'DHCP Client', state: 'Running' },
  { name: 'Schedule', displayName: 'Task Scheduler', state: 'Running' },
  { name: 'wuauserv', displayName: 'Windows Update', state: 'Running' },
  { name: 'WinDefend', displayName: 'Microsoft Defender Antivirus Service', state: 'Running' },
  { name: 'BITS', displayName: 'Background Intelligent Transfer Service', state: 'Running' },
  { name: 'EventLog', displayName: 'Windows Event Log', state: 'Running' }
];

const SIM_PROCESSES = [
  { name: 'explorer.exe', pid: 4321 },
  { name: 'svchost.exe', pid: 890 },
  { name: 'sqlservr.exe', pid: 3120 },
  { name: 'w3wp.exe', pid: 5044 },
  { name: 'powershell.exe', pid: 6210 },
  { name: 'outlook.exe', pid: 7788 },
  { name: 'chrome.exe', pid: 9002 }
];

function getSimState() {
  const state = readJson(simFile(), null);
  if (state && state.current) return state;
  const seeded = { current: { ...SIM_SEED } };
  writeJson(simFile(), seeded);
  return seeded;
}

function saveSimState(state) {
  writeJson(simFile(), state);
}

function getSimCurrent(settingId) {
  const state = getSimState();
  return Object.prototype.hasOwnProperty.call(state.current, settingId)
    ? state.current[settingId]
    : null;
}

function setSimCurrent(settingId, value) {
  const state = getSimState();
  if (value === null || value === undefined) {
    delete state.current[settingId];
  } else {
    state.current[settingId] = String(value);
  }
  saveSimState(state);
}

function resetSim() {
  writeJson(simFile(), { current: { ...SIM_SEED } });
}

module.exports = {
  dataDir,
  getBatches,
  saveBatches,
  addBatch,
  getSimState,
  getSimCurrent,
  setSimCurrent,
  resetSim,
  SIM_SERVICES,
  SIM_PROCESSES
};
