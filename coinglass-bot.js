// coinglass-bot.js
require('dotenv').config();
const axios = require('axios');

const COINGLASS_BASE = process.env.COINGLASS_BASE || 'https://open-api-v4.coinglass.com';
const COINGLASS_KEY = process.env.COINGLASS_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // ex: https://.../tv-webhook
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'troquesecreto';
const SYMBOLS = (process.env.SYMBOLS || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase());
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const MIN_SCORE = Number(process.env.MIN_SCORE || 70);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 2);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 800);

if (!COINGLASS_KEY) {
  console.error('Missing COINGLASS_KEY in env. Get it from your CoinGlass account.');
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error('Missing WEBHOOK_URL in env. Set it to your server /tv-webhook URL.');
  process.exit(1);
}

const axiosCoinglass = axios.create({
  baseURL: COINGLASS_BASE,
  timeout: 10000,
  headers: {
    'coinglass-api-key': COINGLASS_KEY,
    'Accept': 'application/json'
  }
});

async function retry(fn, attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) { last = err; if (i < attempts-1) await new Promise(r => setTimeout(r, delayMs*(i+1))); }
  }
  throw last;
}

// Exemplos de endpoints úteis (docs coinglass):
// /api/futures/funding-rate/exchange-list  -> funding by exchange (gives array of exchanges per symbol)
// /api/futures/global-long-short-account-ratio/history -> long/short account ratio history
// We'll try two endpoints: global long/short and funding-rate exchange list

// --- replace fetchFundingRate ---
async function fetchFundingRate(symbol) {
  try {
    const url = `/api/futures/funding-rate/exchange-list?symbol=${encodeURIComponent(symbol)}`;
    const r = await retry(() => axiosCoinglass.get(url));
    console.log('DEBUG funding response', symbol, JSON.stringify(r.data).slice(0,2000));
    const raw = r.data || {};
    let arr = [];
    if (raw.data && Array.isArray(raw.data) && raw.data.length && raw.data[0].stablecoin_margin_list) {
      arr = raw.data[0].stablecoin_margin_list;
    } else if (raw.data && Array.isArray(raw.data) && raw.data.length && Array.isArray(raw.data[0].list)) {
      arr = raw.data[0].list;
    } else if (raw.data && Array.isArray(raw.data) && raw.data.length && Array.isArray(raw.data[0].exchanges)) {
      arr = raw.data[0].exchanges;
    } else if (raw.data && Array.isArray(raw.data)) {
      arr = [];
      raw.data.forEach(d => {
        if (Array.isArray(d)) d.forEach(i => arr.push(i));
        else arr.push(d);
      });
    }
    if (!arr || !arr.length) return null;
    let values = arr.map(it => {
      if (!it) return 0;
      return Number(it.funding_rate || it.fundingRate || it.funding || it.rate || 0) || 0;
    }).filter(n => typeof n === 'number');
    if (!values.length) return null;
    const sum = values.reduce((s,v) => s+v, 0);
    return sum / values.length;
  } catch (err) {
    console.error('fetchFundingRate error', symbol, err && err.message);
    return null;
  }
}

// --- replace fetchLongShortRatio ---
async function fetchLongShortRatio(symbol) {
  try {
    const url = `/api/futures/global-long-short-account-ratio/history?symbol=${encodeURIComponent(symbol)}&limit=1`;
    const r = await retry(() => axiosCoinglass.get(url));
    console.log('DEBUG ratio response', symbol, JSON.stringify(r.data).slice(0,2000));
    const raw = r.data || {};
    let points = [];
    if (raw.data && Array.isArray(raw.data) && raw.data.length) points = raw.data;
    else if (Array.isArray(raw)) points = raw;
    if (!points.length && raw.data && raw.data.points && Array.isArray(raw.data.points)) points = raw.data.points;
    if (!points.length) return null;
    const last = points[points.length - 1];
    const possible = last || {};
    const ratio = Number(possible.long_short_ratio || possible.long_ratio || possible.ratio || possible.value || possible[1] || 0);
    if (!Number.isFinite(ratio) || ratio === 0) return null;
    return ratio;
  } catch (err) {
    console.error('fetchLongShortRatio error', symbol, err && err.message);
    return null;
  }
}

function scoreFromMetrics(fundingRate, longShortRatio) {
  // Simple scoring:
  // fundingRate: can be +/- small numbers. We'll map fundingRate (-0.002 .. 0.002) to [-50..50]
  // longShortRatio: 0..1 -> long bias (0 => all short, 1 => all long)
  const fr = (typeof fundingRate === 'number') ? fundingRate : 0;
  // scale funding to -50..50 (assuming typical range +/-0.003)
  const frScore = Math.max(-50, Math.min(50, (fr / 0.003) * 50));
  const lsr = (typeof longShortRatio === 'number') ? longShortRatio : 0.5;
  // long base from ratio (0..1) -> 0..100
  const longBase = Math.max(0, Math.min(1, lsr)) * 100;
  // final scores combine both:
  const longScore = Math.max(0, Math.min(100, Math.round((longBase + frScore) / 2)));
  const shortScore = Math.max(0, Math.min(100, 100 - longScore));
  return { longScore, shortScore };
}

async function sendSignal(payload) {
  try {
    await retry(() => axios.post(WEBHOOK_URL, payload, {
      headers: { 'x-webhook-key': WEBHOOK_SECRET, 'Content-Type': 'application/json' },
      timeout: 8000
    }));
    console.log('sent', payload.symbol, 'score', payload.long_score || payload.short_score);
  } catch (err) {
    console.error('sendSignal failed', err && err.message);
  }
}

async function processSymbol(symbol) {
  try {
    const [funding, ratio] = await Promise.all([
      fetchFundingRate(symbol),
      fetchLongShortRatio(symbol)
    ]);
    console.log('metrics', symbol, { funding, ratio });

    const { longScore, shortScore } = scoreFromMetrics(funding, ratio);
    const finalScore = Math.max(longScore, shortScore);
    const side = longScore >= shortScore ? 'long' : 'short';

    const payload = {
      symbol,
      long_score: longScore,
      short_score: shortScore,
      scores: { long_score: longScore, short_score: shortScore },
      tf: 'coinglass',
      meta: { fundingRate: funding, longShortRatio: ratio }
    };

    if (finalScore >= MIN_SCORE) {
      // send signal
      await sendSignal(payload);
    } else {
      console.log('ignored low score', symbol, finalScore);
      // optionally still send logs to webhook as low_score if you want
    }
  } catch (err) {
    console.error('processSymbol error', symbol, err && err.message);
  }
}

async function runOnce() {
  console.log('coinglass-bot tick, symbols=', SYMBOLS.join(','));
  for (const s of SYMBOLS) {
    await processSymbol(s);
    // slight pause between symbols to be nice with rate limits
    await new Promise(r => setTimeout(r, 500));
  }
}

async function mainLoop() {
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error('mainLoop error', err && err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

mainLoop().catch(err => {
  console.error('fatal', err && err.message);
  process.exit(1);
});
