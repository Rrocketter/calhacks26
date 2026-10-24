// Scans tracked + untracked (non-ignored) text files for API key patterns and
// for any value found in .env. Prints file:line [name] only, never the match.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const patterns = [
  { name: 'cartesia', re: /sk_car_[A-Za-z0-9]{10,}/ },
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'factory', re: /fk-[A-Za-z0-9_-]{20,}/ },
];

// Non-secret config whose value is meant to appear in docs and tests (a calendar name).
const NOT_SECRET = new Set(['CALENDAR_EXCLUDE']);

const envValues = [];
if (existsSync('.env')) {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (NOT_SECRET.has(line.slice(0, eq).trim())) continue;
    let v = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (v.length >= 8) envValues.push(v);
  }
}

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

let hits = 0;
for (const file of files) {
  if (!existsSync(file)) continue; // deleted but still indexed
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const p of patterns) {
      if (p.re.test(line)) {
        console.log(`${file}:${i + 1} [${p.name}]`);
        hits++;
      }
    }
    if (envValues.some((v) => line.includes(v))) {
      console.log(`${file}:${i + 1} [env-value]`);
      hits++;
    }
  });
}

if (hits > 0) {
  console.error(`check:secrets failed: ${hits} hit(s)`);
  process.exit(1);
}
console.log('check:secrets ok');
