const fs   = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const filePath = path.join(__dirname, 'catalog.json');
        const data     = fs.readFileSync(filePath, 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).send(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
