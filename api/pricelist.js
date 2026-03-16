const https = require('https');

const ODOO_URL       = process.env.ODOO_URL      || '';
const ODOO_DB        = process.env.ODOO_DB       || '';
const ODOO_USERNAME  = process.env.ODOO_USERNAME || '';
const ODOO_API_KEY   = process.env.ODOO_API_KEY  || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://demexfr.com';

const CATEGORY_MAP = {
    'All / PANNEAU VIKING STRONG':                'Panneau Viking Strong',
    'All / PANNEAU VIKING MEDIUM':                'Panneau Viking Medium',
    'All / PANNEAUX VIKING LIGHT + SAFE + GUARD': 'Panneau Viking Safe & Guard',
    'All / POTEAU VCLIP':                         'Poteaux Viking Clip',
    'All / POTEAU VIKINGFIX':                     'Poteau Viking Fix (à sceller)',
    'All / POTEAU VIKING FIX SUR PLATINE':        'Poteau Viking Fix (sur platine)',
    'All / ACCESSOIRES ET PLATINES':              'Accessoires & Platines Viking Fix',
    'All / PLAQUES DE SOUBASSEMENT':              'Plaques soubassement béton',
    'All / BAMSE':                                'Portillons BAMSE',
    'All / POTEAU KLAMMA':                        'Poteaux Klamma',
    'All / PORTAILS PIVOTANT RAPTOR':             'Raptor (Portails & Portillons)',
    'All / PORTAILS COULISSANT SKENA':            'Skena (Coulissants)',
    'All / PORTAILS AUTOPORTANTS':                'Autoportants',
    'All / SCREEN':                               'Occultant Composite',
    'All / ECLIPSE':                              'Occultant Eclypse',
    'All / GRILLAGE':                             'Grillage simple torsion',
};

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function xmlPost(path, xmlBody) {
    return new Promise((resolve, reject) => {
        const hostname = ODOO_URL.replace(/^https?:\/\//, '').split('/')[0];
        const body = Buffer.from(xmlBody, 'utf8');
        const req = https.request({
            hostname, path, method: 'POST',
            headers: { 'Content-Type': 'text/xml', 'Content-Length': body.length }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const xml = Buffer.concat(chunks).toString('utf8');
                const m = xml.match(/<(?:int|i4)>(\d+)<\/(?:int|i4)>/);
                if (m) resolve(parseInt(m[1]));
                else if (xml.includes('<boolean>0</boolean>')) resolve(false);
                else reject(new Error('Auth failed: ' + xml.slice(0, 300)));
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

function jsonPost(path, params) {
    return new Promise((resolve, reject) => {
        const hostname = ODOO_URL.replace(/^https?:\/\//, '').split('/')[0];
        const body = Buffer.from(JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: 1,
            params: { service: 'object', method: 'execute_kw', args: params }
        }), 'utf8');
        const req = https.request({
            hostname, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (data.error) reject(new Error(JSON.stringify(data.error)));
                    else resolve(data.result);
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

async function odooAuth() {
    const xml = `<?xml version="1.0"?><methodCall><methodName>authenticate</methodName><params>` +
        `<param><value><string>${esc(ODOO_DB)}</string></value></param>` +
        `<param><value><string>${esc(ODOO_USERNAME)}</string></value></param>` +
        `<param><value><string>${esc(ODOO_API_KEY)}</string></value></param>` +
        `<param><value><struct></struct></value></param>` +
        `</params></methodCall>`;
    const uid = await xmlPost('/xmlrpc/2/common', xml);
    if (!uid) throw new Error('Auth échouée');
    return uid;
}

async function odooRpc(uid, model, method, args, kwargs) {
    return jsonPost('/jsonrpc', [ODOO_DB, uid, ODOO_API_KEY, model, method, args||[], kwargs||{}]);
}

async function getDiscountsByPartnerId(uid, partnerId) {
    const partnerData = await odooRpc(uid, 'res.partner', 'read',
        [[partnerId]], { fields: ['name', 'property_product_pricelist'] }
    );
    const pl = partnerData?.[0]?.property_product_pricelist;
    const plId   = pl && Array.isArray(pl) ? pl[0] : (pl || 0);
    const plName = pl && Array.isArray(pl) ? (pl[1] || '') : '';
    if (!plId) return { plId: 0, plName: '', discounts: {} };

    const items = await odooRpc(uid, 'product.pricelist.item', 'search_read',
        [[['pricelist_id', '=', plId]]],
        { fields: ['compute_price','percent_price','price_discount','applied_on','categ_id'] }
    );
    const discounts = {};
    for (const item of (items || [])) {
        let pct = 0;
        if (item.compute_price === 'percentage') pct = item.percent_price || 0;
        else if (item.compute_price === 'formula') pct = item.price_discount || 0;
        if (item.applied_on === '2_product_category' && item.categ_id) {
            const w = CATEGORY_MAP[Array.isArray(item.categ_id) ? item.categ_id[1] : item.categ_id];
            if (w) discounts[w] = pct;
        } else if (item.applied_on === '3_global') {
            for (const w of Object.values(CATEGORY_MAP)) { if (!discounts[w]) discounts[w] = pct; }
        }
    }
    return { plId, plName, discounts };
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    const email     = req.query.email;
    const partnerId = req.query.partner_id ? parseInt(req.query.partner_id) : null;

    if (!email && !partnerId) return res.status(400).json({ error: 'email ou partner_id requis' });

    try {
        const uid = await odooAuth();

        // Mode 1: partner_id direct (portail connecté) — le plus fiable
        if (partnerId) {
            console.log('[DEMEX] partner_id=' + partnerId);
            const result = await getDiscountsByPartnerId(uid, partnerId);
            console.log(`[DEMEX] partner ${partnerId} → ${result.plName} (${Object.keys(result.discounts).length} remises)`);
            return res.json(result);
        }

        // Mode 2: email (admin ou lien direct)
        const pids = await odooRpc(uid, 'res.partner', 'search',
            [[['email', '=', email]]], { limit: 1 });
        if (!pids || !pids.length) {
            // Essai par login utilisateur
            const users = await odooRpc(uid, 'res.users', 'search_read',
                [[['login', '=', email]]], { fields: ['partner_id'], limit: 1 });
            if (users && users.length) {
                const pid = Array.isArray(users[0].partner_id) ? users[0].partner_id[0] : users[0].partner_id;
                const result = await getDiscountsByPartnerId(uid, pid);
                return res.json(result);
            }
            return res.json({ plId: 0, plName: '', discounts: {}, debug: 'not found: ' + email });
        }
        const result = await getDiscountsByPartnerId(uid, pids[0]);
        console.log(`[DEMEX] ${email} → ${result.plName} (${Object.keys(result.discounts).length} remises)`);
        return res.json(result);

    } catch(err) {
        console.error('[DEMEX] ERROR:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
