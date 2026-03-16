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

// ── XML-RPC helper ────────────────────────────────────────────
function xmlVal(v) {
    if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
    if (typeof v === 'number' && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
    if (typeof v === 'number') return `<value><double>${v}</double></value>`;
    if (typeof v === 'boolean') return `<value><boolean>${v?1:0}</boolean></value>`;
    if (Array.isArray(v)) return `<value><array><data>${v.map(xmlVal).join('')}</data></array></value>`;
    if (typeof v === 'object') {
        const members = Object.entries(v).map(([k,val]) =>
            `<member><name>${k}</name>${xmlVal(val)}</member>`).join('');
        return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</string></value>`;
}

function xmlCall(method, params) {
    return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
        params.map(p => `<param>${xmlVal(p)}</param>`).join('')
    }</params></methodCall>`;
}

function parseXml(xml) {
    // Extract fault
    if (xml.includes('<fault>')) {
        const msg = xml.match(/<name>faultString<\/name>\s*<value><string>([^<]*)<\/string>/);
        throw new Error(msg ? msg[1] : 'XML-RPC fault');
    }
    // Parse response value
    return parseValue(xml.match(/<methodResponse>[\s\S]*<\/methodResponse>/)?.[0] || xml);
}

function parseValue(xml) {
    const int    = xml.match(/<(?:int|i4)>(.*?)<\/(?:int|i4)>/);
    if (int) return parseInt(int[1]);
    const dbl    = xml.match(/<double>(.*?)<\/double>/);
    if (dbl) return parseFloat(dbl[1]);
    const bool   = xml.match(/<boolean>(.*?)<\/boolean>/);
    if (bool) return bool[1] === '1';
    const str    = xml.match(/<string>([\s\S]*?)<\/string>/);
    if (str) return str[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const arr    = xml.match(/<array><data>([\s\S]*?)<\/data><\/array>/);
    if (arr) {
        const values = [];
        let rest = arr[1];
        const re = /<value>([\s\S]*?)<\/value>/g;
        let m;
        while ((m = re.exec(rest)) !== null) values.push(parseValue(m[1]));
        return values;
    }
    const struct = xml.match(/<struct>([\s\S]*?)<\/struct>/);
    if (struct) {
        const obj = {};
        const memberRe = /<member><name>(.*?)<\/name><value>([\s\S]*?)<\/value><\/member>/g;
        let m;
        while ((m = memberRe.exec(struct[1])) !== null) obj[m[1]] = parseValue(m[2]);
        return obj;
    }
    return null;
}

function xmlPost(path, body) {
    return new Promise((resolve, reject) => {
        const hostname = ODOO_URL.replace('https://','').replace('http://','').split('/')[0];
        const req = https.request({
            hostname, path, method: 'POST',
            headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(parseXml(data)); }
                catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Odoo XML-RPC calls ────────────────────────────────────────
async function odooAuth() {
    const uid = await xmlPost('/xmlrpc/2/common',
        xmlCall('authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}])
    );
    if (!uid || uid === false) throw new Error('Auth XML-RPC échouée — vérifiez les identifiants Odoo');
    console.log('[DEMEX] Auth XML-RPC OK, uid=' + uid);
    return uid;
}

async function odooExecute(uid, model, method, args, kwargs) {
    return xmlPost('/xmlrpc/2/object',
        xmlCall('execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args || [], kwargs || {}])
    );
}

// ── Handler Vercel ────────────────────────────────────────────
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

        // Chercher le partenaire
        const partners = await odooExecute(uid, 'res.partner', 'search_read',
            [[['email', '=', email]]],
            { fields: ['id', 'name', 'property_product_pricelist'], limit: 1 }
        );

        if (!Array.isArray(partners) || !partners.length) {
            return res.json({ plId: 0, plName: '', discounts: {} });
        }

        const pl = partners[0].property_product_pricelist;
        if (!pl) return res.json({ plId: 0, plName: '', discounts: {} });

        const plId   = Array.isArray(pl) ? pl[0] : pl;
        const plName = Array.isArray(pl) ? pl[1] : '';

        // Lire les règles
        const items = await odooExecute(uid, 'product.pricelist.item', 'search_read',
            [[['pricelist_id', '=', plId]]],
            { fields: ['compute_price','percent_price','price_discount','applied_on','categ_id'] }
        );

        const discounts = {};
        if (Array.isArray(items)) {
            for (const item of items) {
                let pct = 0;
                if (item.compute_price === 'percentage') pct = item.percent_price || 0;
                else if (item.compute_price === 'formula') pct = item.price_discount || 0;

                if (item.applied_on === '2_product_category' && item.categ_id) {
                    const odooName = Array.isArray(item.categ_id) ? item.categ_id[1] : item.categ_id;
                    const w = CATEGORY_MAP[odooName];
                    if (w) discounts[w] = pct;
                } else if (item.applied_on === '3_global') {
                    for (const w of Object.values(CATEGORY_MAP)) {
                        if (!discounts[w]) discounts[w] = pct;
                    }
                }
            }
        }

        console.log(`[DEMEX] ${email} → ${plName} (${Object.keys(discounts).length} remises)`);
        return res.json({ plId, plName, discounts });

    } catch (err) {
        console.error('[DEMEX] Erreur:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
