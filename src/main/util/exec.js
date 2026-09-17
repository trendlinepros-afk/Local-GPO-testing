'use strict';

const { execFile, exec } = require('child_process');

const DEFAULT_OPTS = {
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024
};

/**
 * Run a shell command line. Never rejects — always resolves with a result
 * object so callers can decide what a non-zero exit means.
 */
function run(command, opts = {}) {
  return new Promise((resolve) => {
    exec(command, { ...DEFAULT_OPTS, ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        error: error || null
      });
    });
  });
}

/**
 * Run an executable with an argument array (no shell parsing / injection risk).
 */
function runFile(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { ...DEFAULT_OPTS, ...opts }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: stdout ? stdout.toString() : '',
        stderr: stderr ? stderr.toString() : '',
        error: error || null
      });
    });
  });
}

module.exports = { run, runFile };
