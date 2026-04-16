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

// ── Health HTTP Server ────────────────────────────────────────────────────────
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3000');

const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
        const wsConnected = ws && ws.readyState === WebSocket.OPEN;
        const status = wsConnected ? 'ok' : 'degraded';
        const code = wsConnected ? 200 : 503;
        const body = JSON.stringify({
            status,
            wsConnected,
            symbol: SYMBOL.toUpperCase(),
            lastPrice,
            tradeCount,
            sessionHigh: sessionHigh === -Infinity ? null : sessionHigh,
            sessionLow: sessionLow === Infinity ? null : sessionLow,
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now(),
        });
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(body);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

healthServer.listen(HEALTH_PORT, () => {
    console.log(`\x1b[36m[HEALTH]\x1b[0m Listening on :${HEALTH_PORT}/health`);
});