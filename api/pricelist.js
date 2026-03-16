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

// ── XML-RPC helpers ───────────────────────────────────────────
function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function xmlVal(v) {
    if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
    if (typeof v === 'number' && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
    if (typeof v === 'number') return `<value><double>${v}</double></value>`;
    if (typeof v === 'boolean') return `<value><boolean>${v?1:0}</boolean></value>`;
    if (Array.isArray(v)) return `<value><array><data>${v.map(xmlVal).join('')}</data></array></value>`;
    if (typeof v === 'object') {
        const members = Object.entries(v).map(([k,val]) =>
            `<member><n>${esc(k)}</n>${xmlVal(val)}</member>`).join('');
        return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${esc(String(v))}</string></value>`;
}
function xmlCall(method, params) {
    return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
        params.map(p=>`<param>${xmlVal(p)}</param>`).join('')
    }</params></methodCall>`;
}
function parseXmlValue(s) {
    s = s.trim();
    let m;
    if ((m = s.match(/^<(?:int|i4)>(.*?)<\/(?:int|i4)>$/)))  return parseInt(m[1]);
    if ((m = s.match(/^<double>(.*?)<\/double>$/)))            return parseFloat(m[1]);
    if ((m = s.match(/^<boolean>(.*?)<\/boolean>$/)))          return m[1]==='1';
    if ((m = s.match(/^<string>([\s\S]*?)<\/string>$/)))       return m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    if (s.startsWith('<array>')) {
        const vals=[], inner=s.match(/<data>([\s\S]*?)<\/data>/)?.[1]||'';
        const re=/<value>([\s\S]*?)<\/value>/g; let mx;
        while((mx=re.exec(inner))!==null) vals.push(parseXmlValue(mx[1]));
        return vals;
    }
    if (s.startsWith('<struct>')) {
        const obj={}, re=/<member>\s*<n>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g; let mx;
        while((mx=re.exec(s))!==null) obj[mx[1]]=parseXmlValue(mx[2].trim());
        return obj;
    }
    if (!s.startsWith('<')) return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    return null;
}
function parseXmlResponse(xml) {
    if (xml.includes('<fault>')) {
        const m=xml.match(/<n>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
        throw new Error('XML-RPC fault: '+(m?m[1]:'unknown'));
    }
    const m=xml.match(/<params>\s*<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>\s*<\/params>/);
    if (!m) throw new Error('XML-RPC: no result in: '+xml.slice(0,200));
    return parseXmlValue(m[1].trim());
}
function xmlPost(path, body) {
    return new Promise((resolve,reject) => {
        const hostname=ODOO_URL.replace(/^https?:\/\//,'').split('/')[0];
        const bodyBuf=Buffer.from(body,'utf8');
        const req=https.request({
            hostname, path, method:'POST',
            headers:{'Content-Type':'text/xml; charset=utf-8','Content-Length':bodyBuf.length}
        }, res => {
            const chunks=[];
            res.on('data',c=>chunks.push(c));
            res.on('end',()=>{
                try { resolve(parseXmlResponse(Buffer.concat(chunks).toString('utf8'))); }
                catch(e){ reject(e); }
            });
        });
        req.on('error',reject);
        req.write(bodyBuf); req.end();
    });
}
async function odooAuth() {
    const uid=await xmlPost('/xmlrpc/2/common',
        xmlCall('authenticate',[ODOO_DB,ODOO_USERNAME,ODOO_API_KEY,{}]));
    if (!uid) throw new Error('Auth XML-RPC échouée');
    return uid;
}
async function odooCall(uid, model, method, args, kwargs) {
    return xmlPost('/xmlrpc/2/object',
        xmlCall('execute_kw',[ODOO_DB,uid,ODOO_API_KEY,model,method,args||[],kwargs||{}]));
}

// ── Handler ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method==='OPTIONS') return res.status(200).end();
    if (req.method!=='GET')     return res.status(405).json({error:'Method not allowed'});

    const email=req.query.email;
    if (!email) return res.status(400).json({error:'email requis'});

    try {
        const uid=await odooAuth();

        // 1. Trouver partner_id par email
        const pids=await odooCall(uid,'res.partner','search',
            [[['email','=',email]]],{limit:1});
        if (!Array.isArray(pids)||!pids.length) {
            return res.json({plId:0,plName:'',discounts:{},debug:'partner not found: '+email});
        }
        const partnerId=pids[0];
        console.log('[DEMEX] partner_id='+partnerId);

        // 2. Lire la pricelist via ir.property (champ "property" d'Odoo)
        // C'est comme ça qu'Odoo stocke property_product_pricelist
        const props=await odooCall(uid,'ir.property','search_read',
            [[
                ['name','=','property_product_pricelist'],
                ['res_id','=','res.partner,'+partnerId]
            ]],
            {fields:['value_reference','res_id'],limit:1}
        );
        console.log('[DEMEX] ir.property result:', JSON.stringify(props));

        let plId=0, plName='';

        if (Array.isArray(props)&&props.length&&props[0].value_reference) {
            // value_reference = "product.pricelist,97"
            const ref=props[0].value_reference;
            plId=parseInt(ref.split(',')[1])||0;
        }

        // Fallback: lire directement depuis res.partner avec context
        if (!plId) {
            const partners=await odooCall(uid,'res.partner','read',
                [[partnerId]],
                {fields:['property_product_pricelist'],context:{force_pricelist:true}}
            );
            console.log('[DEMEX] partner read:', JSON.stringify(partners?.[0]));
            const pl=partners?.[0]?.property_product_pricelist;
            if (pl) {
                plId  = Array.isArray(pl)?pl[0]:pl;
                plName= Array.isArray(pl)?(pl[1]||''):'';
            }
        }

        // Fallback 2: chercher la pricelist par défaut de la société
        if (!plId) {
            const defProps=await odooCall(uid,'ir.property','search_read',
                [[['name','=','property_product_pricelist'],['res_id','=',false]]],
                {fields:['value_reference'],limit:1}
            );
            console.log('[DEMEX] default pricelist prop:', JSON.stringify(defProps));
            if (Array.isArray(defProps)&&defProps.length&&defProps[0].value_reference) {
                plId=parseInt(defProps[0].value_reference.split(',')[1])||0;
            }
        }

        if (!plId) return res.json({plId:0,plName:'',discounts:{},debug:'pricelist not found via ir.property'});

        // Récupérer le nom de la pricelist
        if (!plName) {
            const pls=await odooCall(uid,'product.pricelist','read',
                [[plId]],{fields:['name']});
            plName=pls?.[0]?.name||'';
        }
        console.log('[DEMEX] pricelist:', plId, plName);

        // 3. Lire les règles de remise
        const itemIds=await odooCall(uid,'product.pricelist.item','search',
            [[['pricelist_id','=',plId]]]);
        const items=Array.isArray(itemIds)&&itemIds.length
            ? await odooCall(uid,'product.pricelist.item','read',
                [itemIds],{fields:['compute_price','percent_price','price_discount','applied_on','categ_id']})
            : [];

        const discounts={};
        for (const item of (items||[])) {
            let pct=0;
            if (item.compute_price==='percentage') pct=item.percent_price||0;
            else if (item.compute_price==='formula') pct=item.price_discount||0;
            if (item.applied_on==='2_product_category'&&item.categ_id) {
                const name=Array.isArray(item.categ_id)?item.categ_id[1]:item.categ_id;
                const w=CATEGORY_MAP[name];
                if (w) discounts[w]=pct;
            } else if (item.applied_on==='3_global') {
                for (const w of Object.values(CATEGORY_MAP)) { if(!discounts[w]) discounts[w]=pct; }
            }
        }

        console.log(`[DEMEX] ${email} → ${plName} (${Object.keys(discounts).length} remises)`);
        return res.json({plId, plName, discounts});

    } catch(err) {
        console.error('[DEMEX]', err.message);
        return res.status(500).json({error:err.message});
    }
};
