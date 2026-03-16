// Zero dependencies — Node.js natif uniquement
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

// ── JSON-RPC (Odoo interne — pas session/authenticate) ────────
// On utilise /jsonrpc qui accepte la clé API directement
function jsonPost(path, method, params) {
    return new Promise((resolve, reject) => {
        const hostname = ODOO_URL.replace(/^https?:\/\//, '').split('/')[0];
        const body = Buffer.from(JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: 1,
            params: { service: 'object', method, args: params }
        }), 'utf8');
        const req = https.request({
            hostname, path, method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': body.length
            }
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

// Auth via /xmlrpc/2/common avec XML minimal
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
                // Extract int value (uid)
                const m = xml.match(/<(?:int|i4)>(\d+)<\/(?:int|i4)>/);
                if (m) resolve(parseInt(m[1]));
                else if (xml.includes('<boolean>0</boolean>')) resolve(false);
                else reject(new Error('Auth failed: ' + xml.slice(0, 200)));
            });
        });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function odooAuth() {
    const xml = `<?xml version="1.0"?><methodCall><methodName>authenticate</methodName><params>` +
        `<param><value><string>${esc(ODOO_DB)}</string></value></param>` +
        `<param><value><string>${esc(ODOO_USERNAME)}</string></value></param>` +
        `<param><value><string>${esc(ODOO_API_KEY)}</string></value></param>` +
        `<param><value><struct></struct></value></param>` +
        `</params></methodCall>`;
    const uid = await xmlPost('/xmlrpc/2/common', xml);
    if (!uid) throw new Error('Auth échouée — vérifiez ODOO_USERNAME / ODOO_API_KEY');
    console.log('[DEMEX] uid=' + uid);
    return uid;
}

// ORM via /jsonrpc (bypasse la session, utilise uid+password directement)
async function odooRpc(uid, model, method, args, kwargs) {
    return jsonPost('/jsonrpc', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY, model, method, args || [], kwargs || {}
    ]);
}

// ── Handler ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email requis' });

    try {
        const uid = await odooAuth();

        // Chercher res.users par login (email) → lire partner_id + pricelist
        const users = await odooRpc(uid, 'res.users', 'search_read',
            [[['login', '=', email]]],
            { fields: ['name', 'partner_id'], limit: 1 }
        );
        console.log('[DEMEX] users:', JSON.stringify(users));

        let partnerId = null;
        if (users && users.length) {
            partnerId = Array.isArray(users[0].partner_id)
                ? users[0].partner_id[0]
                : users[0].partner_id;
        }

        // Si pas trouvé par login, chercher par email dans res.partner
        if (!partnerId) {
            const partners = await odooRpc(uid, 'res.partner', 'search_read',
                [[['email', '=', email]]],
                { fields: ['id'], limit: 1 }
            );
            console.log('[DEMEX] partners:', JSON.stringify(partners));
            if (partners && partners.length) partnerId = partners[0].id;
        }

        if (!partnerId) {
            return res.json({ plId: 0, plName: '', discounts: {}, debug: 'user/partner not found: ' + email });
        }

        // Lire la pricelist via res.partner — Odoo 18 stocke ça dans la table
        // property_product_pricelist est accessible via search sur product.pricelist
        // en filtrant sur les partenaires. Méthode la plus fiable en v18 :
        // on lit directement le champ via l'ORM avec le bon contexte
        const partnerData = await odooRpc(uid, 'res.partner', 'read',
            [[partnerId]],
            { fields: ['name', 'property_product_pricelist'] }
        );
        console.log('[DEMEX] partnerData:', JSON.stringify(partnerData));

        const pl = partnerData?.[0]?.property_product_pricelist;
        let plId = 0, plName = '';

        if (pl && Array.isArray(pl) && pl[0]) {
            plId   = pl[0];
            plName = pl[1] || '';
        } else if (pl && typeof pl === 'number') {
            plId = pl;
        }

        console.log('[DEMEX] plId=' + plId + ' plName=' + plName);

        if (!plId) {
            return res.json({ plId: 0, plName: '', discounts: {}, debug: 'no pricelist for partner ' + partnerId });
        }

        // Lire les règles
        const items = await odooRpc(uid, 'product.pricelist.item', 'search_read',
            [[['pricelist_id', '=', plId]]],
            { fields: ['compute_price', 'percent_price', 'price_discount', 'applied_on', 'categ_id'] }
        );
        console.log('[DEMEX] items count:', items?.length);

        const discounts = {};
        for (const item of (items || [])) {
            let pct = 0;
            if (item.compute_price === 'percentage') pct = item.percent_price || 0;
            else if (item.compute_price === 'formula') pct = item.price_discount || 0;
            if (item.applied_on === '2_product_category' && item.categ_id) {
                const name = Array.isArray(item.categ_id) ? item.categ_id[1] : item.categ_id;
                const w = CATEGORY_MAP[name];
                if (w) discounts[w] = pct;
            } else if (item.applied_on === '3_global') {
                for (const w of Object.values(CATEGORY_MAP)) { if (!discounts[w]) discounts[w] = pct; }
            }
        }

        console.log(`[DEMEX] ${email} → ${plName} (${Object.keys(discounts).length} remises)`);
        return res.json({ plId, plName, discounts });

    } catch (err) {
        console.error('[DEMEX] ERROR:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
