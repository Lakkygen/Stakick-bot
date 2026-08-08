const base = process.env.WORKER_URL?.replace(/\/+$/, '');
const key = process.env.SETUP_SECRET;

if (!base || !key) {
  console.error('Usage: WORKER_URL=https://your-worker.workers.dev SETUP_SECRET=... npm run setup:webhook');
  process.exit(1);
}

const url = `${base}/setup?key=${encodeURIComponent(key)}`;
const res = await fetch(url);
const text = await res.text();
console.log(text);
if (!res.ok) process.exit(1);
