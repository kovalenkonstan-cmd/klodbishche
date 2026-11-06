// electron-builder afterPack hook: ad-hoc sign the final universal app.
// Ad-hoc ("-") needs no Apple account and is not tied to any identity in the keychain;
// without it Apple Silicon Macs refuse to start a modified Electron app ("damaged").
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (!context.appOutDir.endsWith('mac-universal')) return; // skip per-arch temp builds
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed', app);
};
