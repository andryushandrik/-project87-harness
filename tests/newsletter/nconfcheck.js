// Does nconf.set() win over the .file('default') store, as config/index.ts assumes?
// Uses a key that really is in config.default.json, otherwise the test proves nothing.
const nconf = require('nconf');
const path = require('path');

nconf.argv().env().file('default', path.resolve(__dirname, '../config/config.default.json'));

const KEY = 'mail:devBaseURL';
const fromFile = nconf.get(KEY);
nconf.set(KEY, 'https://derived.example');
const afterSet = nconf.get(KEY);

console.log(`${KEY} from file : ${fromFile}`);
console.log(`${KEY} after set : ${afterSet}`);

const ok = fromFile === 'https://mail.recompro.online' && afterSet === 'https://derived.example';
console.log(ok
  ? '\nok: nconf.set() overrides config.default.json, so applyDerivedDomains wins'
  : '\nFAIL: file store wins, applyDerivedDomains would be dead code');
process.exit(ok ? 0 : 1);
