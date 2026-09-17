'use strict';

// Validates the setting catalog and the compliance baselines so a typo in the
// data files is caught before it reaches the app. Run: node scripts/validate-data.js

const path = require('path');

const catalog = require('../src/data/catalog.json');
const baselineFiles = ['nist', 'cmmc-l2', 'hipaa', 'soc2'];

const errors = [];
const settings = catalog.settings || {};
const settingIds = Object.keys(settings);

if (!settingIds.length) errors.push('catalog.json has no settings.');

const VALID_TYPES = ['secedit', 'registry'];
const VALID_SECTIONS = ['System Access', 'Event Audit'];

for (const id of settingIds) {
  const s = settings[id];
  if (!s.name) errors.push(`${id}: missing name`);
  if (!s.category) errors.push(`${id}: missing category`);
  if (!VALID_TYPES.includes(s.type)) errors.push(`${id}: invalid type "${s.type}"`);
  if (!s.format) errors.push(`${id}: missing format`);

  if (s.type === 'secedit') {
    if (!VALID_SECTIONS.includes(s.section)) errors.push(`${id}: invalid secedit section "${s.section}"`);
    if (!s.key) errors.push(`${id}: secedit setting missing key`);
  }
  if (s.type === 'registry') {
    if (!s.hive) errors.push(`${id}: registry setting missing hive`);
    if (!s.path) errors.push(`${id}: registry setting missing path`);
    if (!s.value) errors.push(`${id}: registry setting missing value name`);
    if (!s.regType) errors.push(`${id}: registry setting missing regType`);
  }

  for (const rule of s.serviceImpacts || []) {
    if (!rule.risk || !['low', 'medium', 'high'].includes(rule.risk)) {
      errors.push(`${id}: serviceImpact has invalid risk "${rule.risk}"`);
    }
    if (!rule.detail) errors.push(`${id}: serviceImpact missing detail`);
  }
  if (s.generalImpact && !['low', 'medium', 'high'].includes(s.generalImpact.risk)) {
    errors.push(`${id}: generalImpact invalid risk "${s.generalImpact.risk}"`);
  }
}

for (const file of baselineFiles) {
  const baseline = require(path.join('..', 'src', 'data', 'baselines', `${file}.json`));
  if (!baseline.id) errors.push(`${file}.json: missing id`);
  if (!baseline.shortName) errors.push(`${file}.json: missing shortName`);
  if (!baseline.name) errors.push(`${file}.json: missing name`);
  const bs = baseline.settings || {};
  const ids = Object.keys(bs);
  if (!ids.length) errors.push(`${file}.json: no settings`);
  for (const id of ids) {
    if (!settings[id]) errors.push(`${file}.json: references unknown setting "${id}"`);
    if (bs[id].desired === undefined || bs[id].desired === null) {
      errors.push(`${file}.json: setting "${id}" missing desired value`);
    }
  }
}

if (errors.length) {
  console.error(`Data validation FAILED with ${errors.length} error(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

console.log(`Data OK: ${settingIds.length} catalog settings, ${baselineFiles.length} baselines validated.`);
