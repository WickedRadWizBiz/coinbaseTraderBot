const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('building talib functions...');

if (process.platform === 'win32') {
  // The C sources are compiled by node-gyp itself (binding.gyp, src/lib/win_sources.js): nothing to build here.
  console.log('windows: TA-Lib C sources are compiled by node-gyp');
} else if (process.platform === 'freebsd') {
  if (fs.existsSync('/usr/local/lib/libta_lib.a')) {
    console.log('package devel/ta-lib is installed. No need to build talib functions.');
  } else {
    console.error('Please install ta-lib from ports collection: pkg install devel/ta-lib');
    process.exit(1);
  }
} else {
  let flags = '';
  if (process.platform === 'darwin') {
    const arch = process.arch === 'ia32' ? 'i386' : process.arch === 'x64' ? 'x86_64' : process.arch;
    flags = `MACOSX_DEPLOYMENT_TARGET=10.7 export CFLAGS="-arch ${arch}" && export LDFLAGS="-arch ${arch}" && `;
  }
  const makeDir = path.join(__dirname, 'make/csr/linux/g++/');
  process.chdir(makeDir);
  exec(`${flags}make`, (err, stdout, stderr) => {
    if (err) {
      console.error('Build failed:', err);
      process.exit(1);
    }
    console.log(stdout);
    if (stderr) console.error(stderr);
  });
}
