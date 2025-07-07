const express = require('express');
const { body, param, validationResult } = require('express-validator');
const geoip = require('geoip-lite');
const crypto = require('crypto');

//Custom Logging Middleware 
const logs = [];
function loggingMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logs.push({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      timestamp: new Date().toISOString(),
      duration: Date.now() - start
    });
  });
  next();
}

//In-memory storage for URLs and stats
const urlStore = new Map(); // shortcode -> { url, expiry, created, clicks: [] }

function generateShortcode(length = 5) {
  let code;
  do {
    code = crypto.randomBytes(length).toString('base64url').slice(0, length);
  } while (urlStore.has(code));
  return code;
}

const app = express();
app.use(express.json());
app.use(loggingMiddleware);

//POST: create short url 
app.post(
  '/shorturls',
  [
    body('url')
      .isString()
      .custom((value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return false;
        }
      })
      .withMessage('Invalid URL format'),
    body('validity')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Validity must be a positive integer'),
    body('shortcode')
      .optional()
      .isString()
      .isLength({ min: 3, max: 20 })
      .withMessage('Shortcode must be 3-20 chars')
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Always return the first error message for clarity
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { url, validity, shortcode } = req.body;
    let code = shortcode;
    if (code) {
      if (urlStore.has(code)) {
        return res.status(409).json({ error: 'Shortcode already exists' });
      }
    } else {
      code = generateShortcode();
    }
    const now = new Date();
    const validMinutes = validity ? parseInt(validity, 10) : 30;
    const expiry = new Date(now.getTime() + validMinutes * 60000);
    urlStore.set(code, {
      url,
      expiry,
      created: now,
      clicks: []
    });
    const host = req.get('host');
    return res.status(201).json({
      shortLink: `http://${host}/${code}`,
      expiry: expiry.toISOString()
    });
  }
);

// Handle GET /shorturls/ with no shortcode
app.get('/shorturls/', (req, res) => {
  res.status(400).json({
    error: 'Shortcode is required in the URL. Usage: /shorturls/:shortcode'
  });
});

//GET : get short url details
app.get(
  '/shorturls/:shortcode',
  [
    param('shortcode')
      .isString()
      .isLength({ min: 3, max: 20 })
      .withMessage('Shortcode must be 3-20 chars')
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    const { shortcode } = req.params;
    const entry = urlStore.get(shortcode);
    if (!entry) {
      return res.status(404).json({ error: 'Shortcode not found' });
    }
    if (new Date() > entry.expiry) {
      return res.status(410).json({ error: 'Short link expired' });
    }
    return res.json({
      shortcode,
      url: entry.url,
      created: entry.created.toISOString(),
      expiry: entry.expiry.toISOString(),
      totalClicks: entry.clicks.length,
      clicks: entry.clicks
    });
  }
);

//GET:redirect to original URL
app.get('/:shortcode', (req, res) => {
  const { shortcode } = req.params;
  const entry = urlStore.get(shortcode);
  if (!entry) {
    return res.status(404).json({ error: 'Shortcode not found' });
  }
  if (new Date() > entry.expiry) {
    return res.status(410).json({ error: 'Short link expired' });
  }
  const referrer = req.get('referer') || null;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress;
  const geo = geoip.lookup(ip) || {};
  entry.clicks.push({
    timestamp: new Date().toISOString(),
    referrer,
    geo: {
      country: geo.country || null,
      region: geo.region || null,
      city: geo.city || null
    }
  });
  return res.redirect(entry.url);
});

// error for unsupported POST to /shorturls/:shortcode
app.post('/shorturls/:shortcode', (req, res) => {
  res.status(405).json({
    error: 'Method Not Allowed. To create a short URL, use POST /shorturls with JSON body. To get stats, use GET /shorturls/:shortcode.'
  });
});

//unknown routes error handler 
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    method: req.method,
    path: req.originalUrl
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
