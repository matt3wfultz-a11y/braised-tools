#!/usr/bin/env node
// Builds dist/AutoBox.zxp — the CEP panel plus AutoBox.jsx — and signs it
// with Adobe's ZXPSignCmd so ZXP Installer (aescripts) or Anastasiy's
// Extension Manager can install it.
//
//   npm run build:zxp
//
// ZXPSignCmd: set ZXPSIGNCMD to its path, or `npm install --no-save zxp-provider`
// to get Adobe's macOS / Windows builds. On Linux the Windows build runs under
// Wine (set WINE if `wine` isn't on your PATH).
//
// Signing certificate: cert/autobox.p12 (git-ignored). A self-signed one is
// created on first build; set ZXP_CERT / ZXP_CERT_PASSWORD to use your own.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUNDLE_ID = 'com.braised.autobox';

// Copy the panel and the shared ExtendScript engine into an extension folder.
function stageExtension(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const copy = (from, to) => fs.cpSync(path.join(ROOT, from), path.join(dest, to), { recursive: true });
  copy('cep/CSXS', 'CSXS');
  copy('cep/css', 'css');
  copy('cep/js', 'js');
  copy('cep/index.html', 'index.html');
  copy('AutoBox.jsx', 'jsx/AutoBox.jsx');
  return dest;
}

function findSigner() {
  if (process.env.ZXPSIGNCMD) return process.env.ZXPSIGNCMD;
  const base = path.join(ROOT, 'node_modules', 'zxp-provider', 'bin', '4.1.1');
  const exe = process.platform === 'darwin' ? path.join(base, 'osx', 'ZXPSignCmd') : path.join(base, 'win64', 'ZXPSignCmd.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('ZXPSignCmd not found. Set ZXPSIGNCMD or run `npm install --no-save zxp-provider`.');
  }
  return exe;
}

// Paths are passed relative to ROOT so they also work for Windows builds under Wine.
function signer(args) {
  const exe = findSigner();
  const useWine = process.platform !== 'win32' && /\.exe$/i.test(exe);
  const [cmd, cmdArgs] = useWine ? [process.env.WINE || 'wine', [exe, ...args]] : [exe, args];
  return execFileSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({ WINEDEBUG: '-all' }, process.env),
  });
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function main() {
  const version = require(path.join(ROOT, 'package.json')).version;
  const stage = stageExtension(path.join(ROOT, 'build', BUNDLE_ID));
  const out = path.join(ROOT, 'dist', 'AutoBox.zxp');
  const cert = process.env.ZXP_CERT || path.join(ROOT, 'cert', 'autobox.p12');
  const password = process.env.ZXP_CERT_PASSWORD || 'braised-autobox';

  if (!fs.existsSync(cert)) {
    fs.mkdirSync(path.dirname(cert), { recursive: true });
    console.log(`Creating self-signed certificate ${rel(cert)}`);
    signer(['-selfSignedCert', 'US', 'CA', 'Braised Animation', 'Braised AutoBox', password, rel(cert), '-validityDays', '7300']);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const tsa = process.env.ZXP_TSA === undefined ? 'http://timestamp.digicert.com' : process.env.ZXP_TSA;
  const sign = ['-sign', rel(stage), rel(out), rel(cert), password];
  try {
    signer(tsa ? sign.concat(['-tsa', tsa]) : sign);
  } catch (err) {
    if (!tsa) throw err;
    console.warn(`Timestamping via ${tsa} failed; signing without a timestamp.`);
    fs.rmSync(out, { force: true });
    signer(sign);
  }
  console.log(signer(['-verify', rel(out)]).trim());
  console.log(`Built ${rel(out)} (AutoBox ${version})`);
}

module.exports = { stageExtension, BUNDLE_ID };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
