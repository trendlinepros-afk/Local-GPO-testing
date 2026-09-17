'use strict';

// Merges a DISA Windows STIG-aligned set of registry-based settings into
// src/data/catalog.json and adds them (with STIG-aligned target values) to all
// four compliance baselines. Idempotent: re-running only adds what's missing.
//
// NOTE: these are STIG-aligned values encoded from the public Windows STIG.
// Treat them as a strong hardening baseline to verify against your current
// official STIG benchmark; org-defined values (log paths, banners, smart-card
// behaviour) and auditpol/user-rights items are intentionally out of scope for
// this registry-focused pass.
//
// Run: node scripts/expand-catalog.js

const fs = require('fs');
const path = require('path');

const P = {
  LSA: 'SYSTEM\\CurrentControlSet\\Control\\Lsa',
  MSV: 'SYSTEM\\CurrentControlSet\\Control\\Lsa\\MSV1_0',
  WINLOGON: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',
  SYSPOL: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
  SESSMGR: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager',
  TCPIP: 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
  TCPIP6: 'SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters',
  NETBT: 'SYSTEM\\CurrentControlSet\\Services\\Netbt\\Parameters',
  SRV: 'SYSTEM\\CurrentControlSet\\Services\\LanmanServer\\Parameters',
  WKS: 'SYSTEM\\CurrentControlSet\\Services\\LanmanWorkstation\\Parameters',
  WKSPOL: 'SOFTWARE\\Policies\\Microsoft\\Windows\\LanmanWorkstation',
  TS: 'SOFTWARE\\Policies\\Microsoft\\Windows NT\\Terminal Services',
  WINRMC: 'SOFTWARE\\Policies\\Microsoft\\Windows\\WinRM\\Client',
  WINRMS: 'SOFTWARE\\Policies\\Microsoft\\Windows\\WinRM\\Service',
  INSTALLER: 'SOFTWARE\\Policies\\Microsoft\\Windows\\Installer',
  EXPLORER: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
  SYSPOL2: 'SOFTWARE\\Policies\\Microsoft\\Windows\\System',
  WDIGEST: 'SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\WDigest',
  PSTRANS: 'SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription',
  DATACOL: 'SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection',
  PERSONAL: 'SOFTWARE\\Policies\\Microsoft\\Windows\\Personalization',
  CREDUI: 'SOFTWARE\\Policies\\Microsoft\\Windows\\CredUI',
  EVTAPP: 'SOFTWARE\\Policies\\Microsoft\\Windows\\EventLog\\Application',
  EVTSEC: 'SOFTWARE\\Policies\\Microsoft\\Windows\\EventLog\\Security',
  EVTSYS: 'SOFTWARE\\Policies\\Microsoft\\Windows\\EventLog\\System'
};

// id, name, category, base, value(name), desired, risk, detail, [reg], [format], [reboot], [svc], [svcDetail]
const NEW = [
  // --- Security Options: LSA / anonymous / credentials ---
  ['RestrictAnonymous', 'Network access: do not allow anonymous enumeration of SAM accounts and shares', 'Local Policies · Security Options', 'LSA', 'RestrictAnonymous', '1', 'medium', 'Blocks anonymous listing of accounts and shares. A few legacy trust/migration tools that enumerate anonymously may lose visibility.'],
  ['EveryoneIncludesAnonymous', 'Network access: let Everyone permissions apply to anonymous users', 'Local Policies · Security Options', 'LSA', 'EveryoneIncludesAnonymous', '0', 'low', 'Anonymous users no longer inherit Everyone permissions.'],
  ['DisableDomainCreds', 'Network access: do not allow storage of passwords and credentials', 'Local Policies · Security Options', 'LSA', 'DisableDomainCreds', '1', 'medium', 'Windows will not cache network credentials. Scheduled tasks or mapped drives relying on stored credentials may prompt or fail.'],
  ['ForceSubcategoryAuditPolicy', 'Audit: force audit policy subcategory settings to override category settings', 'Local Policies · Security Options', 'LSA', 'SCENoApplyLegacyAuditPolicy', '1', 'low', 'Required so advanced (subcategory) audit policy is honoured instead of the legacy nine categories.'],
  ['RunLsassAsPPL', 'Configure LSASS to run as a protected process (RunAsPPL)', 'Local Policies · Security Options', 'LSA', 'RunAsPPL', '1', 'high', 'Protects LSASS from credential theft, but blocks unsigned LSASS plug-ins. Some third-party SSO/AV agents and smart-card middleware may stop loading until updated/signed.', 'DWORD', 'enabledisable', true],
  ['RestrictRemoteSam', 'Network access: restrict clients allowed to make remote calls to SAM', 'Local Policies · Security Options', 'LSA', 'RestrictRemoteSAM', 'O:BAG:BAD:(A;;RC;;;BA)', 'medium', 'Limits remote SAM enumeration to Administrators. Tools that remotely enumerate local accounts as non-admins will be denied.', 'SZ', 'raw'],
  ['NtlmMinClientSec', 'Network security: minimum session security for NTLM SSP clients', 'Local Policies · Security Options', 'MSV', 'NTLMMinClientSec', '537395200', 'medium', 'Requires NTLMv2 session security and 128-bit encryption for outbound NTLM. Legacy servers that cannot negotiate these will refuse the client.', 'DWORD', 'raw', true],
  ['NtlmMinServerSec', 'Network security: minimum session security for NTLM SSP servers', 'Local Policies · Security Options', 'MSV', 'NTLMMinServerSec', '537395200', 'medium', 'Requires NTLMv2 session security and 128-bit encryption for inbound NTLM. Legacy clients will be refused.', 'DWORD', 'raw', true],
  ['AllowNullSessionFallback', 'Network security: allow LocalSystem NULL session fallback', 'Local Policies · Security Options', 'MSV', 'allownullsessionfallback', '0', 'low', 'Prevents NTLM NULL session fallback for LocalSystem.'],
  ['LocalAccountTokenFilterPolicy', 'Apply UAC token-filtering to local accounts on network logons', 'Local Policies · Security Options', 'SYSPOL', 'LocalAccountTokenFilterPolicy', '0', 'medium', 'Local admin accounts get a filtered token over the network, blocking remote admin via local accounts (pass-the-hash mitigation). Remote management tools that rely on a local admin account may break.'],
  ['WDigestUseLogonCredential', 'Disable WDigest clear-text credential caching', 'Local Policies · Security Options', 'WDIGEST', 'UseLogonCredential', '0', 'medium', 'Stops WDigest from caching plaintext credentials in memory (mitigates Mimikatz). No impact on modern authentication.'],

  // --- Interactive logon ---
  ['DontDisplayLastUser', 'Interactive logon: do not display last signed-in user', 'Local Policies · Security Options', 'SYSPOL', 'DontDisplayLastUserName', '1', 'low', 'The username field is blank at logon. Minor convenience impact on shared kiosks.'],
  ['RequireCtrlAltDel', 'Interactive logon: require CTRL+ALT+DEL', 'Local Policies · Security Options', 'SYSPOL', 'DisableCAD', '0', 'low', 'Forces the secure attention sequence before logon (anti credential-harvesting).', 'DWORD', 'cad'],
  ['SmartCardRemovalBehavior', 'Interactive logon: smart card removal behavior (lock workstation)', 'Local Policies · Security Options', 'WINLOGON', 'ScRemoveOption', '1', 'low', 'Locks the session when a smart card is removed. No effect where smart cards are not used.', 'SZ', 'raw'],

  // --- UAC hardening ---
  ['UacInstallerDetection', 'UAC: detect application installations and prompt for elevation', 'Local Policies · Security Options', 'SYSPOL', 'EnableInstallerDetection', '1', 'low', 'Legacy installers are detected and prompted for elevation.'],
  ['UacSecureUiaPaths', 'UAC: only elevate UIAccess applications in secure locations', 'Local Policies · Security Options', 'SYSPOL', 'EnableSecureUIAPaths', '1', 'low', 'UIAccess apps must reside in a secure path (Program Files / System32).'],
  ['UacUiaDesktopToggle', 'UAC: allow UIAccess applications to prompt without the secure desktop', 'Local Policies · Security Options', 'SYSPOL', 'EnableUIADesktopToggle', '0', 'low', 'Keeps elevation prompts on the secure desktop.'],
  ['UacAdminApprovalBuiltin', 'UAC: admin approval mode for the built-in Administrator', 'Local Policies · Security Options', 'SYSPOL', 'FilterAdministratorToken', '1', 'medium', 'The built-in Administrator runs with a filtered token. Automation logging in as the built-in Administrator expecting silent elevation may prompt.'],
  ['UacStandardUserPrompt', 'UAC: behavior of the elevation prompt for standard users (auto-deny)', 'Local Policies · Security Options', 'SYSPOL', 'ConsentPromptBehaviorUser', '0', 'medium', 'Standard users cannot elevate; requests are automatically denied. Apps that expect standard users to elevate on demand will fail.', 'DWORD', 'raw'],
  ['UacVirtualization', 'UAC: virtualize file and registry write failures to per-user locations', 'Local Policies · Security Options', 'SYSPOL', 'EnableVirtualization', '1', 'low', 'Legacy apps writing to protected locations are redirected instead of failing.'],
  ['UacSecureDesktop', 'UAC: switch to the secure desktop when prompting for elevation', 'Local Policies · Security Options', 'SYSPOL', 'PromptOnSecureDesktop', '1', 'low', 'Elevation prompts appear on the secure desktop.'],

  // --- MSS (legacy) ---
  ['MssDisableIpSourceRouting', 'MSS: (DisableIPSourceRouting) IPv4 source routing protection', 'Administrative Templates · MSS (Legacy)', 'TCPIP', 'DisableIPSourceRouting', '2', 'low', 'Highest protection; source-routed IPv4 packets are dropped.', 'DWORD', 'raw'],
  ['MssDisableIpSourceRoutingV6', 'MSS: (DisableIPSourceRouting IPv6) IPv6 source routing protection', 'Administrative Templates · MSS (Legacy)', 'TCPIP6', 'DisableIPSourceRouting', '2', 'low', 'Highest protection; source-routed IPv6 packets are dropped.', 'DWORD', 'raw'],
  ['MssEnableIcmpRedirect', 'MSS: (EnableICMPRedirect) allow ICMP redirects to override OSPF routes', 'Administrative Templates · MSS (Legacy)', 'TCPIP', 'EnableICMPRedirect', '0', 'low', 'ICMP redirects can no longer override the routing table.'],
  ['MssNoNameReleaseOnDemand', 'MSS: (NoNameReleaseOnDemand) ignore NetBIOS name-release requests', 'Administrative Templates · MSS (Legacy)', 'NETBT', 'NoNameReleaseOnDemand', '1', 'low', 'Protects against NetBIOS name-release denial of service.'],
  ['SafeDllSearchMode', 'MSS: enable Safe DLL search mode', 'Administrative Templates · MSS (Legacy)', 'SESSMGR', 'SafeDllSearchMode', '1', 'low', 'System directories are searched before the current directory for DLLs (DLL-planting mitigation).'],

  // --- SMB server signing / sessions ---
  ['SmbServerSignRequire', 'Microsoft network server: digitally sign communications (always)', 'Administrative Templates · Network', 'SRV', 'RequireSecuritySignature', '1', 'medium', 'Requires SMB signing on the server side. Legacy clients/devices that cannot sign will fail to connect to shares.', 'DWORD', 'enabledisable', false, ['LanmanServer'], 'The Server service is running; devices that cannot perform SMB signing will lose access to its shares.'],
  ['SmbServerSignEnable', 'Microsoft network server: digitally sign communications (if client agrees)', 'Administrative Templates · Network', 'SRV', 'EnableSecuritySignature', '1', 'low', 'Enables SMB signing when the client supports it.'],
  ['SmbServerForceLogoff', 'Microsoft network server: disconnect clients when logon hours expire', 'Administrative Templates · Network', 'SRV', 'EnableForcedLogOff', '1', 'low', 'Clients are disconnected when logon hours expire.'],
  ['SmbServerAutoDisconnect', 'Microsoft network server: idle time before suspending a session (minutes)', 'Administrative Templates · Network', 'SRV', 'AutoDisconnect', '15', 'low', 'Idle SMB sessions are suspended after 15 minutes.', 'DWORD', 'raw'],
  ['SmbServerRestrictNullSess', 'Microsoft network server: restrict null-session access', 'Administrative Templates · Network', 'SRV', 'RestrictNullSessAccess', '1', 'low', 'Anonymous (null) sessions cannot access shares/pipes not explicitly allowed.'],
  ['SmbClientSignRequire', 'Microsoft network client: digitally sign communications (always)', 'Administrative Templates · Network', 'WKS', 'RequireSecuritySignature', '1', 'medium', 'Requires SMB signing on the client side. Connections to servers/NAS that cannot sign will fail.', 'DWORD', 'enabledisable', false, ['LanmanWorkstation'], 'The Workstation service is running; connecting to file servers/NAS that cannot sign SMB will fail.'],
  ['SmbClientSignEnable', 'Microsoft network client: digitally sign communications (if server agrees)', 'Administrative Templates · Network', 'WKS', 'EnableSecuritySignature', '1', 'low', 'Enables SMB signing when the server supports it.'],
  ['SmbClientPlaintextPassword', 'Microsoft network client: send unencrypted password to third-party SMB servers', 'Administrative Templates · Network', 'WKS', 'EnablePlainTextPassword', '0', 'low', 'Blocks sending plaintext SMB passwords to non-Microsoft servers.'],
  ['SmbInsecureGuestAuth', 'Enable insecure guest logons (SMB)', 'Administrative Templates · Network', 'WKSPOL', 'AllowInsecureGuestAuth', '0', 'medium', 'Blocks unauthenticated guest access to SMB shares. Scan-to-folder printers and consumer NAS relying on guest SMB will lose access.', 'DWORD', 'enabledisable', false, ['LanmanWorkstation', 'Spooler'], 'Guest SMB access is in use by devices such as scan-to-folder printers or consumer NAS; those will break.'],

  // --- Remote Desktop hardening ---
  ['RdpNoDriveRedirection', 'Remote Desktop: do not allow drive redirection', 'Administrative Templates · Remote Desktop', 'TS', 'fDisableCdm', '1', 'low', 'Blocks mapping of local drives into RDP sessions.', 'DWORD', 'enabledisable', false, ['TermService'], 'Remote Desktop is enabled; users relying on drive redirection lose it.'],
  ['RdpAlwaysPrompt', 'Remote Desktop: always prompt for password upon connection', 'Administrative Templates · Remote Desktop', 'TS', 'fPromptForPassword', '1', 'low', 'RDP always prompts for a password even if the client supplied one.', 'DWORD', 'enabledisable', false, ['TermService'], 'Remote Desktop is enabled; saved-credential RDP logons will now prompt.'],
  ['RdpSecureRpc', 'Remote Desktop: require secure RPC communication', 'Administrative Templates · Remote Desktop', 'TS', 'fEncryptRPCTraffic', '1', 'low', 'Requires encrypted/authenticated RPC for RDP.', 'DWORD', 'enabledisable', false, ['TermService'], 'Remote Desktop is enabled; clients that cannot do secure RPC are refused.'],
  ['RdpDisablePasswordSaving', 'Remote Desktop: do not allow passwords to be saved', 'Administrative Templates · Remote Desktop', 'TS', 'DisablePasswordSaving', '1', 'low', 'The RDP client cannot save passwords.'],
  ['RemoteAssistanceSolicited', 'Configure solicited Remote Assistance (disabled)', 'Administrative Templates · Remote Desktop', 'TS', 'fAllowToGetHelp', '0', 'low', 'Disables solicited Remote Assistance.'],

  // --- WinRM ---
  ['WinRmClientBasic', 'WinRM client: do not allow Basic authentication', 'Administrative Templates · Windows Remote Management', 'WINRMC', 'AllowBasic', '0', 'medium', 'Blocks Basic auth for the WinRM client. Remote management scripts using Basic auth will break.', 'DWORD', 'enabledisable', false, ['WinRM'], 'WinRM is running; Basic-auth remote management will stop working.'],
  ['WinRmClientUnencrypted', 'WinRM client: do not allow unencrypted traffic', 'Administrative Templates · Windows Remote Management', 'WINRMC', 'AllowUnencryptedTraffic', '0', 'medium', 'Requires encrypted WinRM client traffic.', 'DWORD', 'enabledisable', false, ['WinRM'], 'WinRM is running; unencrypted client sessions will be refused.'],
  ['WinRmClientDigest', 'WinRM client: do not allow Digest authentication', 'Administrative Templates · Windows Remote Management', 'WINRMC', 'AllowDigest', '0', 'low', 'Blocks Digest auth for the WinRM client.'],
  ['WinRmServiceBasic', 'WinRM service: do not allow Basic authentication', 'Administrative Templates · Windows Remote Management', 'WINRMS', 'AllowBasic', '0', 'medium', 'Blocks Basic auth for the WinRM service. Inbound management using Basic auth will break.', 'DWORD', 'enabledisable', false, ['WinRM'], 'WinRM is running; inbound Basic-auth management will stop working.'],
  ['WinRmServiceUnencrypted', 'WinRM service: do not allow unencrypted traffic', 'Administrative Templates · Windows Remote Management', 'WINRMS', 'AllowUnencryptedTraffic', '0', 'medium', 'Requires encrypted WinRM service traffic.', 'DWORD', 'enabledisable', false, ['WinRM'], 'WinRM is running; unencrypted inbound sessions will be refused.'],
  ['WinRmServiceRunAs', 'WinRM service: disable RunAs credential storage', 'Administrative Templates · Windows Remote Management', 'WINRMS', 'DisableRunAs', '1', 'low', 'Prevents storing RunAs credentials in the WinRM service.'],

  // --- Windows Installer ---
  ['InstallerAlwaysElevated', 'Windows Installer: always install with elevated privileges (disabled)', 'Administrative Templates · Windows Installer', 'INSTALLER', 'AlwaysInstallElevated', '0', 'medium', 'Prevents standard users from installing MSIs as SYSTEM (a well-known privilege-escalation path). If a workflow relied on it, packages must be deployed via a management tool instead.'],
  ['InstallerUserControl', 'Windows Installer: allow user control over installs (disabled)', 'Administrative Templates · Windows Installer', 'INSTALLER', 'EnableUserControl', '0', 'low', 'Prevents users from changing protected install options.'],

  // --- Explorer / AutoPlay / DEP ---
  ['ExplorerNoAutorun', 'Turn off AutoRun commands', 'Administrative Templates · AutoPlay Policies', 'EXPLORER', 'NoAutorun', '1', 'low', 'Disables the AutoRun command from executing on any drive.'],
  ['ExplorerDEP', 'Turn off Data Execution Prevention for Explorer (must be off)', 'Administrative Templates · AutoPlay Policies', 'EXPLORER', 'NoDataExecutionPrevention', '0', 'low', 'Keeps DEP enabled for Explorer.'],
  ['ExplorerHeapTermination', 'Turn off heap termination on corruption (must be off)', 'Administrative Templates · AutoPlay Policies', 'EXPLORER', 'NoHeapTerminationOnCorruption', '0', 'low', 'Keeps heap-corruption termination enabled for Explorer.'],
  ['ExplorerShellProtocol', 'Use the protected-mode shell protocol (PreXPSP2ShellProtocolBehavior off)', 'Administrative Templates · AutoPlay Policies', 'EXPLORER', 'PreXPSP2ShellProtocolBehavior', '0', 'low', 'Keeps the shell protocol in protected mode.'],

  // --- SmartScreen ---
  ['SmartScreenEnable', 'Configure Windows Defender SmartScreen', 'Administrative Templates · Windows Defender SmartScreen', 'SYSPOL2', 'EnableSmartScreen', '1', 'low', 'Turns on SmartScreen app/file reputation checks.'],
  ['SmartScreenLevel', 'Windows Defender SmartScreen level (Block)', 'Administrative Templates · Windows Defender SmartScreen', 'SYSPOL2', 'ShellSmartScreenLevel', 'Block', 'low', 'Sets SmartScreen to warn and block, not just warn.', 'SZ', 'raw'],

  // --- PowerShell transcription ---
  ['PsTranscription', 'Turn on PowerShell transcription', 'Administrative Templates · Windows PowerShell', 'PSTRANS', 'EnableTranscription', '1', 'low', 'Records a transcript of all PowerShell activity. Increases log volume; set an output directory ACL.'],

  // --- Telemetry / privacy ---
  ['AllowTelemetry', 'Allow Diagnostic Data (Telemetry) — Security level', 'Administrative Templates · Data Collection', 'DATACOL', 'AllowTelemetry', '0', 'low', 'Limits Windows diagnostic data to the Security level.', 'DWORD', 'raw'],

  // --- Lock screen ---
  ['NoLockScreenCamera', 'Prevent enabling lock-screen camera', 'Administrative Templates · Control Panel (Personalization)', 'PERSONAL', 'NoLockScreenCamera', '1', 'low', 'Disables camera access from the lock screen.'],
  ['NoLockScreenSlideshow', 'Prevent enabling lock-screen slide show', 'Administrative Templates · Control Panel (Personalization)', 'PERSONAL', 'NoLockScreenSlideshow', '1', 'low', 'Disables the lock-screen slide show.'],

  // --- Credential UI ---
  ['CredUiNoPasswordReveal', 'Do not display the password reveal button', 'Administrative Templates · Credential UI', 'CREDUI', 'DisablePasswordReveal', '1', 'low', 'Removes the "reveal password" eye button from credential dialogs.'],
  ['CredUiNoAdminEnumeration', 'Enumerate administrator accounts on elevation (disabled)', 'Administrative Templates · Credential UI', 'CREDUI', 'EnumerateAdministrators', '0', 'low', 'Does not list admin accounts when a standard user elevates.'],

  // --- Event log sizing ---
  ['EventLogAppSize', 'Application log: maximum size (KB)', 'Administrative Templates · Event Log Service', 'EVTAPP', 'MaxSize', '32768', 'low', 'Ensures the Application log retains enough history (min 32,768 KB).', 'DWORD', 'raw'],
  ['EventLogSecSize', 'Security log: maximum size (KB)', 'Administrative Templates · Event Log Service', 'EVTSEC', 'MaxSize', '1024000', 'low', 'Ensures the Security log retains enough history (min 1,024,000 KB).', 'DWORD', 'raw'],
  ['EventLogSysSize', 'System log: maximum size (KB)', 'Administrative Templates · Event Log Service', 'EVTSYS', 'MaxSize', '32768', 'low', 'Ensures the System log retains enough history (min 32,768 KB).', 'DWORD', 'raw']
];

function build(entry) {
  const [id, name, category, baseKey, value, desired, risk, detail, reg, format, reboot, svc, svcDetail] = entry;
  const regType = reg === 'SZ' ? 'REG_SZ' : 'REG_DWORD';
  const valueKind = reg === 'SZ' ? 'string' : desired === '0' || desired === '1' ? 'bool' : 'int';
  const fmt = format || (reg === 'SZ' ? 'raw' : valueKind === 'bool' ? 'enabledisable' : 'raw');
  const def = {
    name,
    category,
    description: detail,
    type: 'registry',
    hive: 'HKLM',
    path: P[baseKey],
    value,
    regType,
    valueKind,
    format: fmt,
    generalImpact: { risk, detail },
    serviceImpacts: svc ? [{ services: svc, risk, detail: svcDetail || detail }] : []
  };
  if (reboot) def.reboot = true;
  return { id, def, desired };
}

const catalogPath = path.join(__dirname, '..', 'src', 'data', 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

let added = 0;
const ids = [];
for (const entry of NEW) {
  const { id, def, desired } = build(entry);
  ids.push({ id, desired });
  if (!catalog.settings[id]) {
    catalog.settings[id] = def;
    added += 1;
  } else {
    catalog.settings[id] = { ...catalog.settings[id], ...def }; // keep in sync
  }
}
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

const baselineFiles = ['nist', 'cmmc-l2', 'hipaa', 'soc2'];
for (const file of baselineFiles) {
  const bp = path.join(__dirname, '..', 'src', 'data', 'baselines', `${file}.json`);
  const b = JSON.parse(fs.readFileSync(bp, 'utf8'));
  let bAdded = 0;
  for (const { id, desired } of ids) {
    if (!b.settings[id]) {
      b.settings[id] = { desired };
      bAdded += 1;
    }
  }
  fs.writeFileSync(bp, JSON.stringify(b, null, 2) + '\n', 'utf8');
  console.log(`${file}: +${bAdded} settings, total ${Object.keys(b.settings).length}`);
}

console.log(`\ncatalog: +${added} new settings, total ${Object.keys(catalog.settings).length}`);
