import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'jaakkopasanen/AutoEq';
const path = 'results/Rtings/HMS II.3 over-ear/SteelSeries Arctis 7+/SteelSeries Arctis 7+ ParametricEQ.txt';
const headers = { 'User-Agent': 'AdaptiveEQ-local-prototype' };
async function get(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response;
}
const commit = (await (await get(`https://api.github.com/repos/${repo}/commits/master`)).json()).sha;
const sourceUrl = `https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
const [preset, license] = await Promise.all([
  get(sourceUrl).then(r => r.text()),
  get(`https://raw.githubusercontent.com/${repo}/${commit}/LICENSE`).then(r => r.text()),
]);
const preamp = preset.match(/^Preamp:\s*([-\d.]+) dB/m);
const types = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf' };
const filters = [...preset.matchAll(/^Filter \d+: ON (PK|LSC|HSC) Fc ([\d.]+) Hz Gain ([-\d.]+) dB Q ([\d.]+)/gm)]
  .map(([, type, frequency, gain, q]) => ({ type: types[type], frequency: Number(frequency), gain: Number(gain), q: Number(q) }));
if (!preamp || filters.length !== 10 || filters.some(f => !Number.isFinite(f.gain) || f.frequency <= 0 || f.q <= 0)) {
  throw new Error('Unexpected source format; review the upstream preset before importing.');
}
const profile = {
  id: 'steelseries-arctis-7-plus', name: 'SteelSeries Arctis 7+',
  measurementSource: 'RTINGS', measurementRig: 'HMS II.3 over-ear',
  target: 'Published AutoEq target', preampDb: Number(preamp[1]), filters,
  provenance: { repository: `https://github.com/${repo}`, commit, sourceUrl, sha256: createHash('sha256').update(preset).digest('hex'),
    presetUrl: '/profiles/steelseries-arctis-7-plus-parametric.txt', licenseUrl: '/licenses/AutoEq-MIT.txt', importedOn: '2026-10-31' },
};
await mkdir(`${root}/src/data`, { recursive: true });
await mkdir(`${root}/public/profiles`, { recursive: true });
await mkdir(`${root}/public/licenses`, { recursive: true });
await writeFile(`${root}/src/data/arctis-7-plus.json`, JSON.stringify(profile, null, 2) + '\n');
await writeFile(`${root}/public/profiles/steelseries-arctis-7-plus-parametric.txt`, preset);
await writeFile(`${root}/public/licenses/AutoEq-MIT.txt`, license);
console.log(JSON.stringify({ profile: profile.name, filters: filters.length, preampDb: profile.preampDb, commit }));
