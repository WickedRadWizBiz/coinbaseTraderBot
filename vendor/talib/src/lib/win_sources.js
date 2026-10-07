// Windows: the TA-Lib C sources compiled straight into the addon by node-gyp (binding.gyp), listed from the
// same Makefile the Linux build uses (ta_libc = ta_common + ta_func + ta_abstract), paths relative to binding.gyp.
const fs = require('fs');
const path = require('path');
const mk = fs.readFileSync(path.join(__dirname, 'make/csr/linux/g++/ta_libc/Makefile'), 'utf8');
const block = mk.slice(mk.indexOf('SOURCES'), mk.indexOf('OBJECTS'));
const files = block.split(/[\s\\]+/).filter((x) => x.endsWith('.c')).map((x) => 'src/lib/' + x.replace(/^(\.\.\/)+/, ''));
console.log(files.join(' '));
