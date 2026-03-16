module.exports = async function handler(req, res) {
    var ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://demexfr.com';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (req.method === 'OPTIONS') return res.status(200).end();
    var catalog = require('./catalog.json');
    return res.json(catalog);
};
