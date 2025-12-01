// servidor.js - versão melhorada (substitua seu servidor.js por este)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); 
app.use(express.json({ limit: '1mb' }));

// Configs via ENV
const PORT = process.env.PORT || 8080;
const BASE44_BASE = process.env.BASE44_BASE || 'https://api.base44.com'; // confirme o path correto
const BASE44_KEY = process.env.BASE44_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'troquesecreto';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHATID = process.env.TELEGRAM_CHATID || '';
const MIN_SCORE = Number(process.env.MIN_SCORE || 70);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 2);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 800);

// Headers padrão para Base44 (confirme se x-api-key é correto)
const BASE44_HEADERS = { 'x-api-key': BASE44_KEY, 'Content-Type': 'application/json' };

// Rate limit (ajuste conforme necessário)
app.use(rateLimit({
  windowMs: 15 * 1000, // 15s
  max: 30, // máximo 30 requests por IP por janela
  standardHeaders: true,
  legacyHeaders: false
}));

function genEventId(payload = {}) {
  const s = (payload.event_id || '') + '|' + (payload.symbol||'') + '|' + (payload.tf||'') + '|' + (payload.timestamp||'');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function authorized(req) {
  const key = (req.headers['x-webhook-key'] || req.headers['x-secret'] || '').toString();
  if (!key) return false;
  if (key === WEBHOOK_SECRET) return true;
  // fallback: allow secret in body (dev only)
  return !!(req.body && req.body.secret && req.body.secret === WEBHOOK_SECRET);
}

// util retry com delay
async function retry(fn, attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (i+1)));
    }
  }
  throw lastErr;
}

// Faz POST para Base44 (confirme URL/rota com docs do Base44)
async function createBase44Record(collection, obj) {
  // ajuste de endpoint caso sua API exija /api/apps/<appId>/collections/...
  const url = `${BASE44_BASE}/collections/${collection}/records`;
  return retry(() => axios.post(url, obj, { headers: BASE44_HEADERS, timeout: 8000 }));
}

// simples validação numérica
function asNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

app.post('/tv-webhook', async (req, res) => {
  try {
    if (!authorized(req)) {
      console.warn('unauthorized request from', req.ip);
      return res.status(401).send({ ok:false, msg:'unauthorized' });
    }

    const payload = req.body || {};
    payload.event_id = payload.event_id || genEventId(payload);

    // grava log inicial (não bloq)
    try {
      await createBase44Record('WebhookLog', {
        event_id: payload.event_id,
        payload,
        source: 'tradingview',
        status: 'received',
        attempts: 0,
        processed_at: null
      });
    } catch(e) {
      console.error('base44 log receive failed', e && e.message);
    }

    // responde rápido
    res.status(202).send({ ok:true, event_id: payload.event_id });

    // processamento async
    setImmediate(async () => {
      try {
        const longScore = asNumber(payload.long_score || (payload.scores && payload.scores.long_score));
        const shortScore = asNumber(payload.short_score || (payload.scores && payload.scores.short_score));
        const finalScore = Math.max(longScore, shortScore);
        const side = longScore >= shortScore ? 'long' : 'short';

        // valida básicas do simbolo
        const symbol = (payload.symbol || payload.ticker || 'UNKNOWN').toString();
        const tf = (payload.tf || payload.timeframe || 'unknown').toString();

        if (finalScore >= MIN_SCORE) {
          const signal = {
            event_id: payload.event_id,
            symbol,
            tf,
            side,
            score: finalScore,
            conditions: payload.indicators || payload.conditions || {},
            meta: payload.meta || {},
            status: 'active',
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 1000*60*60).toISOString()
          };

          try {
            await createBase44Record('signals', signal);
            console.info('signal stored', signal.event_id, signal.symbol, signal.score);
          } catch (e) {
            console.error('failed storing signal', e && e.message);
          }

          try {
            await createBase44Record('WebhookLog', {
              event_id: payload.event_id,
              payload,
              source: 'server',
              status: 'processed',
              attempts: 1,
              processed_at: new Date().toISOString()
            });
          } catch(e) {
            console.error('base44 log processed failed', e && e.message);
          }

          // Telegram notify (opcional)
          if (TELEGRAM_TOKEN && TELEGRAM_CHATID) {
            try {
              const turl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
              const text = `🔥 Sinal ${side.toUpperCase()} ${signal.symbol}\nScore ${signal.score} | TF ${signal.tf}`;
              await retry(() => axios.post(turl, { chat_id: TELEGRAM_CHATID, text }, { timeout:5000 }), 2, 500);
            } catch (e) {
              console.error('telegram notify failed', e && e.message);
            }
          }
        } else {
          // low score
          try {
            await createBase44Record('WebhookLog', {
              event_id: payload.event_id,
              payload,
              source: 'server',
              status: 'ignored_low_score',
              attempts: 1,
              processed_at: new Date().toISOString()
            });
            console.info('ignored low score', payload.event_id, finalScore);
          } catch(e) {
            console.error('base44 log low_score failed', e && e.message);
          }
        }
      } catch (err) {
        console.error('processing error', err && err.stack);
        try {
          await createBase44Record('WebhookLog', {
            event_id: payload.event_id,
            payload,
            source: 'server',
            status: 'error',
            attempts: 1,
            processed_at: new Date().toISOString(),
            error_message: err && err.message
          });
        } catch(e) {
          console.error('failed to log error to base44', e && e.message);
        }
      }
    });

  } catch(err) {
    console.error('handler error', err && err.stack);
    return res.status(500).send({ ok:false, error: err && err.message });
  }
});

app.get('/healthz', (req,res) => res.send({ ok:true }));
// rota raiz para evitar "Cannot GET /"

app.get('/', (req, res) => {
  res.send('Servidor online — use /healthz para testar e POST /tv-webhook para enviar sinais.');
});

app.listen(PORT, ()=>console.log('listening', PORT));
