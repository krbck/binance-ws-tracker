/**
 * Binance USD-M Futures — SOLUSDT Real-time Price Tracker
 * Fiyat koşulu sağlandığında n8n webhook'una POST atar.
 *
 * Env vars:
 *   N8N_WEBHOOK_URL  — n8n webhook URL (zorunlu değil, yoksa sadece loglar)
 *   SYMBOL           — default: solusdt
 *   ALERT_THRESHOLD  — fiyat değişim % eşiği (default: 0.5 → %0.5)
 *   ALERT_COOLDOWN   — aynı yönde tekrar alert için bekleme ms (default: 60000)
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOL = (process.env.SYMBOL || 'solusdt').toLowerCase();
const STREAM = `${SYMBOL}@aggTrade`;
const WS_URL = `wss://fstream.binance.com/ws/${STREAM}`;
const RECONNECT_MS = 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || null;
const ALERT_THRESHOLD = parseFloat(process.env.ALERT_THRESHOLD || '0.5');
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN || '60000');

// ── State ─────────────────────────────────────────────────────────────────────
let lastPrice = null;
let refPrice = null;
let tradeCount = 0;
let sessionHigh = -Infinity;
let sessionLow = Infinity;
let ws = null;
let reconnectTimer = null;
let lastAlertAt = 0;
let lastAlertDir = null;

// ── Trade State (shared between n8n workflows) ───────────────────────────────
const tradeState = {};  // keyed by chatId
const STATE_TTL = 30 * 60 * 1000; // 30min auto-expire

// ── Helpers ───────────────────────────────────────────────────────────────────
function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function colorPrice(current, previous) {
    if (previous === null) return `\x1b[37m${current.toFixed(4)}\x1b[0m`;
    if (current > previous) return `\x1b[32m▲ ${current.toFixed(4)}\x1b[0m`;
    if (current < previous) return `\x1b[31m▼ ${current.toFixed(4)}\x1b[0m`;
    return `\x1b[33m= ${current.toFixed(4)}\x1b[0m`;
}

function printTick(price, qty, isBuyerMaker) {
    const side = isBuyerMaker ? '\x1b[31mSELL\x1b[0m' : '\x1b[32mBUY \x1b[0m';
    const pStr = colorPrice(price, lastPrice);
    const hStr = `\x1b[90mH: ${sessionHigh.toFixed(4)}\x1b[0m`;
    const lStr = `\x1b[90mL: ${sessionLow.toFixed(4)}\x1b[0m`;
    const cStr = `\x1b[90m#${tradeCount}\x1b[0m`;
    process.stdout.write(
        `\r[${ts()}] ${SYMBOL.toUpperCase()}-PERP | ${side} | Price: ${pStr} | Qty: ${parseFloat(qty).toFixed(2)} | ${hStr} ${lStr} | ${cStr}   `
    );
}

// ── n8n Webhook POST ──────────────────────────────────────────────────────────
function postToN8n(payload) {
    if (!N8N_WEBHOOK_URL) return;
    const body = JSON.stringify(payload);
    const url = new URL(N8N_WEBHOOK_URL);
    const client = url.protocol === 'https:' ? https : http;
    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const req = client.request(options, (res) => {
        console.log(`\n\x1b[36m[N8N]\x1b[0m Webhook → HTTP ${res.statusCode}`);
    });
    req.on('error', (e) => {
        console.error(`\n\x1b[31m[N8N ERR]\x1b[0m ${e.message}`);
    });
    req.write(body);
    req.end();
}

// ── Alert Logic ───────────────────────────────────────────────────────────────
function checkAlert(price) {
    if (refPrice === null) { refPrice = price; return; }
    const changePct = ((price - refPrice) / refPrice) * 100;
    const now = Date.now();
    const cooldownOk = (now - lastAlertAt) >= ALERT_COOLDOWN;
    if (Math.abs(changePct) >= ALERT_THRESHOLD) {
        const dir = changePct > 0 ? 'UP' : 'DOWN';
        if (cooldownOk || dir !== lastAlertDir) {
            const payload = {
                symbol: SYMBOL.toUpperCase(), price, refPrice,
                changePct: parseFloat(changePct.toFixed(4)),
                direction: dir, timestamp: now,
                tradeCount, sessionHigh, sessionLow,
            };
            console.log(`\n\x1b[35m[ALERT]\x1b[0m ${dir} ${Math.abs(changePct).toFixed(3)}% | ref: ${refPrice.toFixed(4)} → now: ${price.toFixed(4)}`);
            postToN8n(payload);
            lastAlertAt = now;
            lastAlertDir = dir;
            refPrice = price;
        }
    }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
    console.log(`\n\x1b[36m[WS]\x1b[0m Connecting → ${WS_URL}`);
    ws = new WebSocket(WS_URL);
    ws.on('open', () => {
        console.log(`\x1b[32m[WS]\x1b[0m Connected. Streaming ${SYMBOL.toUpperCase()} Futures aggTrade...`);
        if (N8N_WEBHOOK_URL) {
            console.log(`\x1b[36m[N8N]\x1b[0m Webhook: ${N8N_WEBHOOK_URL}`);
            console.log(`\x1b[36m[CFG]\x1b[0m Alert threshold: ±${ALERT_THRESHOLD}% | Cooldown: ${ALERT_COOLDOWN}ms\n`);
        } else {
            console.log(`\x1b[33m[WARN]\x1b[0m N8N_WEBHOOK_URL not set — logging only\n`);
        }
    });
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (msg.e !== 'aggTrade') return;
        const price = parseFloat(msg.p);
        const qty = parseFloat(msg.q);
        tradeCount++;
        if (price > sessionHigh) sessionHigh = price;
        if (price < sessionLow) sessionLow = price;
        printTick(price, qty, msg.m);
        checkAlert(price);
        lastPrice = price;
    });
    ws.on('ping', (data) => { ws.pong(data); });
    ws.on('error', (err) => {
        console.error(`\n\x1b[31m[WS ERR]\x1b[0m ${err.message}`);
    });
    ws.on('close', (code) => {
        console.log(`\n\x1b[33m[WS]\x1b[0m Closed (code: ${code}). Reconnecting in ${RECONNECT_MS}ms...`);
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown() {
    console.log('\n\n\x1b[36m[INFO]\x1b[0m Shutting down...');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    console.log(`\x1b[36m[SUMMARY]\x1b[0m`);
    console.log(`  Total trades : ${tradeCount}`);
    console.log(`  Session High : ${sessionHigh === -Infinity ? 'N/A' : sessionHigh.toFixed(4)}`);
    console.log(`  Session Low  : ${sessionLow === Infinity ? 'N/A' : sessionLow.toFixed(4)}`);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════════════\x1b[0m');
console.log(`\x1b[1m  Binance USD-M Futures — ${SYMBOL.toUpperCase()} Price Tracker   \x1b[0m`);
console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════════════\x1b[0m');
connect();

// ── HTTP API Server ───────────────────────────────────────────────────────────
const API_PORT = parseInt(process.env.API_PORT || process.env.HEALTH_PORT || '3000');

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

function jsonResponse(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(body);
}

const apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    // ── GET /health ───────────────────────────────────────────────────────
    if (path === '/health' && req.method === 'GET') {
        const wsConnected = ws && ws.readyState === WebSocket.OPEN;
        jsonResponse(res, wsConnected ? 200 : 503, {
            status: wsConnected ? 'I am good' : 'degraded',
        });

        // ── GET /status ───────────────────────────────────────────────────────
    } else if (path === '/status' && req.method === 'GET') {
        const wsConnected = ws && ws.readyState === WebSocket.OPEN;
        jsonResponse(res, wsConnected ? 200 : 503, {
            status: wsConnected ? 'ok' : 'degraded',
            wsConnected,
            symbol: SYMBOL.toUpperCase(),
            lastPrice,
            tradeCount,
            sessionHigh: sessionHigh === -Infinity ? null : sessionHigh,
            sessionLow: sessionLow === Infinity ? null : sessionLow,
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now(),
        });

        // ── GET /price ────────────────────────────────────────────────────────
        // n8n calls this to get the current price before sending Telegram msg
    } else if (path === '/price' && req.method === 'GET') {
        if (lastPrice !== null) {
            // Use live WS price
            jsonResponse(res, 200, {
                symbol: SYMBOL.toUpperCase(),
                price: lastPrice,
                sessionHigh: sessionHigh === -Infinity ? null : sessionHigh,
                sessionLow: sessionLow === Infinity ? null : sessionLow,
                tradeCount,
                source: 'websocket',
                timestamp: Date.now(),
            });
        } else {
            // Fallback: fetch from Binance REST API
            const apiUrl = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${SYMBOL.toUpperCase()}`;
            console.log(`\n\x1b[33m[PRICE]\x1b[0m WS price not available, fetching from REST API...`);
            https.get(apiUrl, (apiRes) => {
                let data = '';
                apiRes.on('data', (chunk) => { data += chunk; });
                apiRes.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const fallbackPrice = parseFloat(parsed.price);
                        console.log(`\x1b[32m[PRICE]\x1b[0m REST API → ${fallbackPrice}`);
                        jsonResponse(res, 200, {
                            symbol: SYMBOL.toUpperCase(),
                            price: fallbackPrice,
                            sessionHigh: null,
                            sessionLow: null,
                            tradeCount: 0,
                            source: 'rest_api',
                            timestamp: Date.now(),
                        });
                    } catch (e) {
                        jsonResponse(res, 500, { error: 'Failed to parse Binance API response' });
                    }
                });
            }).on('error', (e) => {
                console.error(`\x1b[31m[PRICE ERR]\x1b[0m REST API failed: ${e.message}`);
                jsonResponse(res, 503, { error: `Price unavailable: ${e.message}` });
            });
        }

        // ── POST /trade ───────────────────────────────────────────────────────
        // n8n sends collected trade params here after Telegram conversation
    } else if (path === '/trade' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { symbol, side, amount, leverage, chatId, username } = data;

            // Validate required fields
            const missing = [];
            if (!side) missing.push('side');
            if (!amount) missing.push('amount');
            if (!leverage) missing.push('leverage');
            if (missing.length > 0) {
                jsonResponse(res, 400, { error: `Missing fields: ${missing.join(', ')}` });
                return;
            }

            const tradeSymbol = (symbol || SYMBOL).toUpperCase();
            const tradeSide = side.toUpperCase();
            const tradeAmount = parseFloat(amount);
            const tradeLeverage = parseInt(leverage);
            const tradePrice = lastPrice;

            // ── Verbose terminal log ──────────────────────────────────────
            const now = new Date();
            const timeStr = now.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
            const positionSize = tradeAmount * tradeLeverage;
            const qty = tradePrice ? positionSize / tradePrice : 0;
            const liqDistance = tradeLeverage > 0 ? (100 / tradeLeverage) : 0;
            const liqPrice = tradePrice
                ? (tradeSide === 'BUY'
                    ? tradePrice * (1 - liqDistance / 100)
                    : tradePrice * (1 + liqDistance / 100))
                : null;

            console.log('\n');
            console.log('\x1b[1m\x1b[35m╔═══════════════════════════════════════════════════════════════╗\x1b[0m');
            console.log('\x1b[1m\x1b[35m║              📊  NEW TRADE ORDER RECEIVED                    ║\x1b[0m');
            console.log('\x1b[1m\x1b[35m╠═══════════════════════════════════════════════════════════════╣\x1b[0m');
            console.log('\x1b[1m\x1b[35m║\x1b[0m                                                               \x1b[35m║\x1b[0m');
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m⏰ Request Time     :\x1b[0m  ${timeStr}            \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m👤 Telegram User    :\x1b[0m  ${username ? '@' + username : 'N/A'}                          \x1b[35m║\x1b[0m`);
            console.log('\x1b[1m\x1b[35m║\x1b[0m                                                               \x1b[35m║\x1b[0m');
            console.log('\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[33m─── TRADE DETAILS ─────────────────────────────────\x1b[0m   \x1b[35m║\x1b[0m');
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m📈 Symbol           :\x1b[0m  ${tradeSymbol}-PERP (USD-M Futures)     \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m📌 Side             :\x1b[0m  ${tradeSide === 'BUY' ? '\x1b[1m\x1b[32m🟢 LONG (BUY)' : '\x1b[1m\x1b[31m🔴 SHORT (SELL)'}\x1b[0m                    \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m💰 Current Price    :\x1b[0m  $${tradePrice ? tradePrice.toFixed(4) : 'N/A'}                         \x1b[35m║\x1b[0m`);
            console.log('\x1b[1m\x1b[35m║\x1b[0m                                                               \x1b[35m║\x1b[0m');
            console.log('\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[33m─── POSITION BREAKDOWN ────────────────────────────\x1b[0m   \x1b[35m║\x1b[0m');
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m💵 Margin (USD)     :\x1b[0m  $${tradeAmount.toFixed(2)}                            \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m⚡ Leverage         :\x1b[0m  ${tradeLeverage}x                                \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m📦 Position Size    :\x1b[0m  $${positionSize.toFixed(2)}                          \x1b[35m║\x1b[0m`);
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m📐 Est. Quantity    :\x1b[0m  ${qty.toFixed(4)} ${tradeSymbol}                    \x1b[35m║\x1b[0m`);
            if (liqPrice) {
                console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m💀 Est. Liq. Price  :\x1b[0m  \x1b[31m$${liqPrice.toFixed(4)}\x1b[0m (≈${liqDistance.toFixed(1)}% away)       \x1b[35m║\x1b[0m`);
            }
            console.log('\x1b[1m\x1b[35m║\x1b[0m                                                               \x1b[35m║\x1b[0m');
            const riskLevel = tradeLeverage <= 3 ? '\x1b[32m🟢 LOW' : tradeLeverage <= 10 ? '\x1b[33m🟡 MEDIUM' : tradeLeverage <= 25 ? '\x1b[31m🔴 HIGH' : '\x1b[1m\x1b[31m⛔ EXTREME';
            console.log(`\x1b[1m\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m⚠️  Risk Level      :\x1b[0m  ${riskLevel}\x1b[0m                          \x1b[35m║\x1b[0m`);
            console.log('\x1b[1m\x1b[35m║\x1b[0m                                                               \x1b[35m║\x1b[0m');
            console.log('\x1b[1m\x1b[35m╠═══════════════════════════════════════════════════════════════╣\x1b[0m');
            console.log('\x1b[1m\x1b[33m║  ⚠  STATUS: LOGGED ONLY — Futures execution not yet active   ║\x1b[0m');
            console.log('\x1b[1m\x1b[35m╚═══════════════════════════════════════════════════════════════╝\x1b[0m');
            console.log('');

            jsonResponse(res, 200, {
                status: 'received',
                order: {
                    symbol: tradeSymbol,
                    side: tradeSide,
                    amount: tradeAmount,
                    leverage: tradeLeverage,
                    entryPrice: tradePrice,
                    positionSize: tradePrice ? tradeAmount * tradeLeverage : null,
                    estimatedQty: tradePrice ? (tradeAmount * tradeLeverage) / tradePrice : null,
                },
                message: 'Trade logged to terminal. Futures execution not yet implemented.',
            });

        } catch (err) {
            console.error(`\n\x1b[31m[TRADE ERR]\x1b[0m ${err.message}`);
            jsonResponse(res, 400, { error: err.message });
        }

        // ── GET /states (debug) ────────────────────────────────────────────────
    } else if (path === '/states' && req.method === 'GET') {
        const keys = Object.keys(tradeState);
        console.log(`\n\x1b[33m[DEBUG]\x1b[0m GET /states → ${keys.length} stored states: [${keys.join(', ')}]`);
        jsonResponse(res, 200, { count: keys.length, keys, states: tradeState });

        // ── GET /state/:chatId ─────────────────────────────────────────────────
        // n8n reads conversational state for a chat
    } else if (path.startsWith('/state/') && req.method === 'GET') {
        const chatId = path.split('/state/')[1];
        const allKeys = Object.keys(tradeState);
        console.log(`\n\x1b[33m[DEBUG]\x1b[0m GET /state → looking for chatId="${chatId}" (type: ${typeof chatId})`);
        console.log(`\x1b[33m[DEBUG]\x1b[0m Stored keys: [${allKeys.map(k => `"${k}" (type: ${typeof k})`).join(', ')}]`);
        const state = tradeState[chatId];
        if (!state) {
            console.log(`\x1b[31m[DEBUG]\x1b[0m NOT FOUND — no state for chatId="${chatId}"`);
            jsonResponse(res, 200, { hasState: false, chatId });
        } else if (Date.now() - state.createdAt > STATE_TTL) {
            delete tradeState[chatId];
            console.log(`\x1b[31m[DEBUG]\x1b[0m EXPIRED — state for chatId="${chatId}" was too old`);
            jsonResponse(res, 200, { hasState: false, chatId, reason: 'expired' });
        } else {
            console.log(`\x1b[32m[DEBUG]\x1b[0m FOUND — state for chatId="${chatId}": step=${state.step}`);
            jsonResponse(res, 200, { hasState: true, ...state });
        }

        // ── POST /state ───────────────────────────────────────────────────────
        // n8n writes/updates conversational state
    } else if (path === '/state' && req.method === 'POST') {
        try {
            const data = await parseBody(req);
            const { chatId } = data;
            if (!chatId) {
                jsonResponse(res, 400, { error: 'chatId is required' });
                return;
            }
            // Merge with existing state or create new
            tradeState[chatId] = { ...(tradeState[chatId] || {}), ...data, updatedAt: Date.now() };
            if (!tradeState[chatId].createdAt) tradeState[chatId].createdAt = Date.now();
            console.log(`\n\x1b[36m[STATE]\x1b[0m Updated state for chat ${chatId}: step=${tradeState[chatId].step}`);
            jsonResponse(res, 200, { status: 'ok', state: tradeState[chatId] });
        } catch (err) {
            jsonResponse(res, 400, { error: err.message });
        }

        // ── DELETE /state/:chatId ──────────────────────────────────────────────
    } else if (path.startsWith('/state/') && req.method === 'DELETE') {
        const chatId = path.split('/state/')[1];
        delete tradeState[chatId];
        jsonResponse(res, 200, { status: 'deleted', chatId });

    } else {
        jsonResponse(res, 404, { error: 'Not found' });
    }
});

apiServer.listen(API_PORT, () => {
    console.log(`\x1b[36m[API]\x1b[0m Server listening on :${API_PORT} → /health /status /price /trade /state /states`);
});