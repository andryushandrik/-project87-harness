// Mirrors config/index.ts domain resolution: derive first, env overrides after.
const extractDomain = (url) => {
  try { return new URL(url).hostname.replace(/^mail\./, ''); } catch { return ''; }
};

const resolve = (env) => {
  const store = {};
  const mailBaseUrl = env.NODE_ENV === 'production' ? env.MAIL_BASE_PROD_URL : env.MAIL_BASE_DEV_URL;
  const domain = extractDomain(mailBaseUrl || '');
  if (domain) {
    store['mail:domain'] = domain;
    store.domain = `https://${domain}`;
  }
  // env mapping runs after derivation, so it wins
  if (env.DEV_MAIL_DOMAIN !== undefined) store['mail:domain'] = env.DEV_MAIL_DOMAIN;
  if (env.DOMAIN !== undefined) store.domain = env.DOMAIN;
  return store;
};

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};

const PROD = 'https://mail.recompro.online';

console.log('production, no overrides:');
check('derives both', resolve({
  NODE_ENV: 'production', MAIL_BASE_PROD_URL: PROD,
}), { 'mail:domain': 'recompro.online', domain: 'https://recompro.online' });

console.log('dev, .env.example as shipped:');
check('DOMAIN overrides, mail:domain derived', resolve({
  MAIL_BASE_DEV_URL: PROD, DOMAIN: 'http://localhost:3000',
}), { 'mail:domain': 'recompro.online', domain: 'http://localhost:3000' });

console.log('dev, local mail service:');
check('DEV_MAIL_DOMAIN overrides sender host', resolve({
  MAIL_BASE_DEV_URL: 'http://localhost:1080',
  DEV_MAIL_DOMAIN: 'recompro.online',
  DOMAIN: 'http://localhost:3000',
}), { 'mail:domain': 'recompro.online', domain: 'http://localhost:3000' });

console.log('edge cases:');
check('unparseable url leaves nothing set', resolve({ MAIL_BASE_DEV_URL: 'not a url' }), {});
check('missing url leaves nothing set', resolve({}), {});
check('override still applies without a url', resolve({
  DEV_MAIL_DOMAIN: 'recompro.online', DOMAIN: 'https://recompro.online',
}), { 'mail:domain': 'recompro.online', domain: 'https://recompro.online' });
check('host without mail. prefix is kept whole', resolve({
  MAIL_BASE_DEV_URL: 'https://recompro.online',
}), { 'mail:domain': 'recompro.online', domain: 'https://recompro.online' });

console.log(failed ? `\n${failed} FAILURE(S)` : '\nall domain cases pass');
process.exit(failed ? 1 : 0);
