const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const TREASURY_RATES_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?fields=record_date,security_type_desc,security_desc,avg_interest_rate_amt&sort=-record_date&page[size]=12';
const CACHE_TTL_MS = 10 * 60 * 1000;
let treasuryRatesCache = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 32) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function readLeads() {
  try {
    const raw = await fs.readFile(LEADS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeLead(lead) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const leads = await readLeads();
  leads.push(lead);
  await fs.writeFile(LEADS_FILE, JSON.stringify(leads, null, 2));
}

async function handleLead(req, res) {
  try {
    const body = await readBody(req);
    const input = JSON.parse(body || '{}');
    const name = cleanText(input.name, 120);
    const email = cleanText(input.email, 160).toLowerCase();
    const interest = cleanText(input.interest, 80);

    if (!name || !email || !interest) {
      return sendJson(res, 400, { error: 'Name, email, and interest are required.' });
    }

    if (!isValidEmail(email)) {
      return sendJson(res, 400, { error: 'Enter a valid email address.' });
    }

    const lead = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name,
      email,
      company: cleanText(input.company, 120),
      role: cleanText(input.role, 120),
      interest,
      message: cleanText(input.message, 1000)
    };

    await writeLead(lead);
    return sendJson(res, 201, { ok: true, id: lead.id });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(res, 400, { error: 'Invalid JSON payload.' });
    }
    if (error.message === 'Request body too large') {
      return sendJson(res, 413, { error: 'Request is too large.' });
    }
    console.error(error);
    return sendJson(res, 500, { error: 'Could not save your request.' });
  }
}

async function handleTreasuryRates(req, res) {
  try {
    const now = Date.now();
    if (treasuryRatesCache && now - treasuryRatesCache.fetchedAt < CACHE_TTL_MS) {
      return sendJson(res, 200, treasuryRatesCache.payload);
    }

    const response = await fetch(TREASURY_RATES_URL, {
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Treasury API returned ${response.status}`);
    }

    const payload = await response.json();
    const rates = (payload.data || []).map(item => ({
      recordDate: item.record_date,
      type: item.security_type_desc,
      security: item.security_desc,
      rate: Number(item.avg_interest_rate_amt)
    })).filter(item => item.recordDate && item.security && Number.isFinite(item.rate));

    if (!rates.length) {
      throw new Error('Treasury API returned no rates');
    }

    const result = {
      source: 'U.S. Treasury Fiscal Data',
      sourceUrl: 'https://fiscaldata.treasury.gov/',
      updatedAt: new Date().toISOString(),
      recordDate: rates[0].recordDate,
      rates
    };

    treasuryRatesCache = { fetchedAt: now, payload: result };
    return sendJson(res, 200, result);
  } catch (error) {
    console.error(error);
    return sendJson(res, 502, { error: 'Could not load Treasury rate data.' });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT) || filePath.includes(`${path.sep}data${path.sep}`)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && req.url === '/api/leads') {
    return handleLead(req, res);
  }

  if (req.method === 'GET' && req.url === '/api/treasury-rates') {
    return handleTreasuryRates(req, res);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }

  res.writeHead(405, { Allow: 'GET, HEAD, POST' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`BondTrader site running at http://localhost:${PORT}`);
});
