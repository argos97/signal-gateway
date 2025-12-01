require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const BASE44_BASE = process.env.BASE44_BASE || 'https://api.base44.com';
const BASE44_KEY = process.env.BASE44_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'troquesecreto';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHATID = process.env.TELEGRAM_CHATID || '';
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '70', 10);

const BASE44_HEADERS = { 'x-api-key': BASE44_KEY, 'Content-Type': 'application/json' };

function genEventId(payload) {
  const s = (payload.event_id || '') + '|' + (payload.symbol||'') + '|' + (payload.tf||'') + '|' + (payload.timestamp||'');
  return crypto.createHash('sha256').update(s).digest('hex');
}

function authorized(req) {
  const key = req.headers['x-webhook-key'] || req.headers['x-secret'];
  if(!key) return false;
  return key === WEBHOOK_SECRET || (req.body && req.body.secret && req.body.secret === WEBHOOK_SECRET);
}

async function createBase44Record(collection, obj) {
  const url = `${BASE44_BASE}/collections/${collection}/records`;
  return axios.post(url, obj, { headers: BASE44_HEADERS, timeout: 8000 });
}

app.post('/tv-webhook', async (req, res) => {
  try {
    if(!authorized(req)) return res.status(401).send({ ok:false, msg:'unauthorized' });

    const payload = req.body || {};
    payload.event_id = payload.event_id || genEventId(payload);

    await createBase44Record('WebhookLog', {
      event_id: payload.event_id,
      payload,
      source: 'tradingview',
      status: 'received',
      attempts: 0,
      processed_at: null
    }).catch(()=>{});

    res.status(202).send({ ok:true, event_id: payload.event_id });

    setImmediate(async () => {
      try {
        const longScore = payload.long_score || (payload.scores && payload.scores.long_score) || 0;
        const shortScore = payload.short_score || (payload.scores && payload.scores.short_score) || 0;
        const finalScore = Math.max(longScore, shortScore);
        const side = longScore >= shortScore ? 'long' : 'short';

        if(finalScore >= MIN_SCORE) {
          const signal = {
            event_id: payload.event_id,
            symbol: payload.symbol || 'UNKNOWN',
            tf: payload.tf || '5m',
            side,
            score: finalScore,
            conditions: payload.indicators || {},
            meta: payload.meta || {},
            status: 'active',
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 1000*60*60).toISOString()
          };

          await createBase44Record('signals', signal).catch(()=>{});

          await createBase44Record('WebhookLog', {
            event_id: payload.event_id,
            payload,
            source: 'server',
            status: 'processed',
            attempts: 1,
            processed_at: new Date().toISOString()
          }).catch(()=>{});

          if(TELEGRAM_TOKEN && TELEGRAM_CHATID) {
            try {
              const turl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
              const text = `🔥 Sinal ${side.toUpperCase()} ${signal.symbol}\nScore ${signal.score} | TF ${signal.tf}`;
              await axios.post(turl, { chat_id: TELEGRAM_CHATID, text }, { timeout:5000 });
            } catch(e) {}
          }
        } else {
          await createBase44Record('WebhookLog', {
            event_id: payload.event_id,
            payload,
            source: 'server',
            status: 'ignored_low_score',
            attempts: 1,
            processed_at: new Date().toISOString()
          }).catch(()=>{});
        }

      } catch(err) {
        await createBase44Record('WebhookLog', {
          event_id: payload.event_id,
          payload,
          source: 'server',
          status: 'error',
          attempts: 1,
          processed_at: new Date().toISOString(),
          error_message: err.message
        }).catch(()=>{});
      }
    });

  } catch(err) {
    console.error('handler error', err.message);
    return res.status(500).send({ ok:false, error: err.message });
  }
});

app.get('/healthz', (req,res) => res.send({ ok:true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('listening', PORT));
