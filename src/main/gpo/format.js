'use strict';

// Human-readable rendering of a raw setting value. Comparison is always done
// on the normalized raw string; this is display only.

const LM_COMPAT = {
  '0': 'Send LM & NTLM responses',
  '1': 'Send LM & NTLM — use NTLMv2 if negotiated',
  '2': 'Send NTLM response only',
  '3': 'Send NTLMv2 response only',
  '4': 'Send NTLMv2 only, refuse LM',
  '5': 'Send NTLMv2 only, refuse LM & NTLM'
};

const AUDIT = {
  '0': 'No auditing',
  '1': 'Success',
  '2': 'Failure',
  '3': 'Success + Failure'
};

const UAC_ADMIN_PROMPT = {
  '0': 'Elevate without prompting',
  '1': 'Prompt for credentials on the secure desktop',
  '2': 'Prompt for consent on the secure desktop',
  '3': 'Prompt for credentials',
  '4': 'Prompt for consent',
  '5': 'Prompt for consent for non-Windows binaries'
};

const RDP_ENC = {
  '1': 'Low',
  '2': 'Client Compatible',
  '3': 'High',
  '4': 'FIPS Compliant'
};

function normalize(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

function formatValue(raw, setting) {
  const s = normalize(raw);
  if (s === null) return 'Not configured';

  switch (setting && setting.format) {
    case 'enabledisable':
      if (s === '1') return 'Enabled';
      if (s === '0') return 'Disabled';
      return s;
    case 'guestaccount':
      return s === '1' ? 'Guest account ENABLED' : 'Guest account disabled';
    case 'smb1':
      return s === '1' ? 'SMBv1 ENABLED' : 'SMBv1 disabled';
    case 'count':
      return s;
    case 'days':
      return `${s} day(s)`;
    case 'maxage':
      return s === '0' || s === '-1' ? 'Never expires' : `${s} day(s)`;
    case 'minutes':
      return `${s} minute(s)`;
    case 'lockoutduration':
      return s === '0' ? 'Until an admin unlocks' : `${s} minute(s)`;
    case 'seconds':
      return s === '0' ? 'Disabled (no auto-lock)' : `${s} second(s)`;
    case 'cad':
      return s === '0' ? 'CTRL+ALT+DEL required' : 'Not required';
    case 'audit':
      return AUDIT[s] || `Value ${s}`;
    case 'lmcompat':
      return LM_COMPAT[s] || `Level ${s}`;
    case 'uacprompt':
      return UAC_ADMIN_PROMPT[s] || `Value ${s}`;
    case 'rdpenc':
      return RDP_ENC[s] || `Value ${s}`;
    case 'raw':
    default:
      return s;
  }
}

module.exports = { formatValue, normalize };
