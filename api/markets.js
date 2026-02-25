// Vercel Serverless Function — serves pre-computed headlines from data/headlines.json
// The heavy lifting (data fetching, LLM curation) is done offline by generate.js
// and committed to the repo by GitHub Actions on a schedule.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let cached = null;

function loadHeadlines() {
  // In Vercel, the file is bundled with the deployment.
  // Cache in memory across warm invocations.
  if (cached) return cached;

  try {
    const filePath = join(__dirname, '..', 'data', 'headlines.json');
    const raw = readFileSync(filePath, 'utf-8');
    cached = JSON.parse(raw);
    return cached;
  } catch (err) {
    console.error('Failed to read headlines.json:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const data = loadHeadlines();

  if (!data) {
    res.status(503).json({
      error: 'Headlines not yet generated',
      message: 'The curation pipeline has not run yet. Trigger it manually or wait for the next scheduled run.',
    });
    return;
  }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.status(200).json(data);
}
