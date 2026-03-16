const xmlrpc = require('xmlrpc');

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

function getClients() {
    const host = ODOO_URL.replace(/^https?:\/\//, '').split('/')[0];
    const opts  = { host, port: 443, path: '/xmlrpc/2/common' };
    const opts2 = { host, port: 443, path: '/xmlrpc/2/object' };
    return {
        common: xmlrpc.createSecureClient(opts),
        object: xmlrpc.createSecureClient(opts2),
    };
}

function call(client, method, params) {
    return new Promise((resolve, reject) => {
        client.methodCall(method, params, (err, val) => {
            if (err) reject(err); else resolve(val);
        });
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
        const { common, object } = getClients();

        // 1. Auth
        const uid = await call(common, 'authenticate',
            [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}]);
        if (!uid) throw new Error('Auth échouée');
        console.log('[DEMEX] uid=' + uid);

        // 2. Partner par email
        const pids = await call(object, 'execute_kw',
            [ODOO_DB, uid, ODOO_API_KEY, 'res.partner', 'search',
             [[['email', '=', email]]], { limit: 1 }]);
        console.log('[DEMEX] pids:', pids);

        if (!pids || !pids.length) {
            return res.json({ plId: 0, plName: '', discounts: {}, debug: 'partner not found' });
        }

        // 3. Lire pricelist via ir.property
        const props = await call(object, 'execute_kw',
            [ODOO_DB, uid, ODOO_API_KEY, 'ir.property', 'search_read',
             [[['name','=','property_product_pricelist'],
               ['res_id','=','res.partner,'+pids[0]]]],
             { fields: ['value_reference'], limit: 1 }]);
        console.log('[DEMEX] ir.property:', JSON.stringify(props));

        let plId = 0, plName = '';

        if (props && props.length && props[0].value_reference) {
            plId = parseInt(props[0].value_reference.split(',')[1]) || 0;
        }

        // Fallback: lire la pricelist par défaut (res_id = false)
        if (!plId) {
            const defProps = await call(object, 'execute_kw',
                [ODOO_DB, uid, ODOO_API_KEY, 'ir.property', 'search_read',
                 [[['name','=','property_product_pricelist'],['res_id','=',false]]],
                 { fields: ['value_reference'], limit: 1 }]);
            console.log('[DEMEX] default ir.property:', JSON.stringify(defProps));
            if (defProps && defProps.length && defProps[0].value_reference) {
                plId = parseInt(defProps[0].value_reference.split(',')[1]) || 0;
            }
        }

        if (!plId) {
            return res.json({ plId: 0, plName: '', discounts: {}, debug: 'no pricelist in ir.property' });
        }

        // 4. Nom de la pricelist
        const pls = await call(object, 'execute_kw',
            [ODOO_DB, uid, ODOO_API_KEY, 'product.pricelist', 'read',
             [[plId]], { fields: ['name'] }]);
        plName = pls?.[0]?.name || '';
        console.log('[DEMEX] pricelist:', plId, plName);

        // 5. Règles de remise
        const itemIds = await call(object, 'execute_kw',
            [ODOO_DB, uid, ODOO_API_KEY, 'product.pricelist.item', 'search',
             [[['pricelist_id', '=', plId]]]]);

        const items = itemIds && itemIds.length ? await call(object, 'execute_kw',
            [ODOO_DB, uid, ODOO_API_KEY, 'product.pricelist.item', 'read',
             [itemIds],
             { fields: ['compute_price','percent_price','price_discount','applied_on','categ_id'] }])
            : [];

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
        console.error('[DEMEX]', err.message);
        return res.status(500).json({ error: err.message });
    }
};
