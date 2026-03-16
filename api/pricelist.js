const fetch = require('node-fetch');

const ODOO_URL       = process.env.ODOO_URL;
const ODOO_DB        = process.env.ODOO_DB;
const ODOO_USERNAME  = process.env.ODOO_USERNAME;
const ODOO_API_KEY   = process.env.ODOO_API_KEY;
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

// Session cookie persistante entre les appels
let _sessionCookie = null;

async function odooPost(path, params) {
    const headers = { 'Content-Type': 'application/json' };
    if (_sessionCookie) headers['Cookie'] = _sessionCookie;

    const res = await fetch(`${ODOO_URL}${path}`, {
        method:  'POST',
        headers: headers,
        body: JSON.stringify({
            jsonrpc: '2.0', method: 'call',
            id: Math.floor(Math.random() * 99999),
            params,
        }),
    });

    // Sauvegarder le cookie de session
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
        _sessionCookie = setCookie.split(';')[0];
    }

    const data = await res.json();
    if (data.error) throw new Error(data.error.data?.message || JSON.stringify(data.error));
    return data.result;
}

async function odooAuth() {
    // Odoo 18 : la clé API s'utilise comme mot de passe dans authenticate
    const result = await odooPost('/web/session/authenticate', {
        db:       ODOO_DB,
        login:    ODOO_USERNAME,
        password: ODOO_API_KEY,
    });
    if (!result || !result.uid) throw new Error('Auth Odoo échouée — vérifiez ODOO_USERNAME et ODOO_API_KEY');
    console.log('[DEMEX] Auth OK, uid=' + result.uid);
    return result.uid;
}

async function odooRpc(model, method, args, kwargs) {
    return odooPost('/web/dataset/call_kw', {
        model, method,
        args:   args   || [],
        kwargs: kwargs || {},
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'email requis' });

    try {
        // Auth (réutilise le cookie si déjà authentifié)
        if (!_sessionCookie) await odooAuth();

        // Chercher le partenaire par email
        const partners = await odooRpc('res.partner', 'search_read',
            [[['email', '=', email]]],
            { fields: ['id', 'name', 'property_product_pricelist'], limit: 1 }
        );

        if (!partners || !partners.length) {
            return res.json({ plId: 0, plName: '', discounts: {} });
        }

        const pl = partners[0].property_product_pricelist;
        if (!pl || !pl[0]) {
            return res.json({ plId: 0, plName: '', discounts: {} });
        }

        const plId = pl[0], plName = pl[1];

        // Lire les règles de remise
        const items = await odooRpc('product.pricelist.item', 'search_read',
            [[['pricelist_id', '=', plId]]],
            { fields: ['compute_price','percent_price','price_discount','applied_on','categ_id'] }
        );

        const discounts = {};
        for (const item of items) {
            let pct = 0;
            if (item.compute_price === 'percentage') pct = item.percent_price || 0;
            else if (item.compute_price === 'formula') pct = item.price_discount || 0;

            if (item.applied_on === '2_product_category' && item.categ_id) {
                const w = CATEGORY_MAP[item.categ_id[1]];
                if (w) discounts[w] = pct;
            } else if (item.applied_on === '3_global') {
                for (const w of Object.values(CATEGORY_MAP)) {
                    if (!discounts[w]) discounts[w] = pct;
                }
            }
        }

        console.log(`[DEMEX] ${email} → ${plName} (${Object.keys(discounts).length} remises)`);
        return res.json({ plId, plName, discounts });

    } catch (err) {
        // Session expirée → reset et réessayer une fois
        if (err.message.includes('session') || err.message.includes('Access')) {
            _sessionCookie = null;
            try {
                await odooAuth();
                // Retry simplifié
                return res.status(500).json({ error: 'Session réinitialisée, réessayez' });
            } catch (e2) {
                return res.status(500).json({ error: e2.message });
            }
        }
        console.error('[DEMEX] Erreur:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
