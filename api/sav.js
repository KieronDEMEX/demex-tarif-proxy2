// api/sav.js
export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin;
  const allowed = process.env.ALLOWED_ORIGIN?.split(',') || [];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // Connexion Odoo
    const odooUrl = process.env.ODOO_URL;
    const db = process.env.ODOO_DB;
    const username = process.env.ODOO_USERNAME;
    const apiKey = process.env.ODOO_API_KEY;

    // 1. Authentification
    const authRes = await fetch(`${odooUrl}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { db, login: username, password: apiKey }
      })
    });

    const authData = await authRes.json();
    if (!authData.result || !authData.result.uid) {
      throw new Error('Authentification Odoo échouée');
    }

    const sessionId = authRes.headers.get('set-cookie');

    // 2. Actions SAV
    if (action === 'health') {
      return res.json({ 
        status: 'OK', 
        odoo_connected: true,
        odoo_user: authData.result.username 
      });
    }

    if (action === 'installations') {
      const { email } = req.query;
      // Appel RPC pour lire les installations
      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionId 
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'demex.installation', // Nom du modèle Odoo
            method: 'search_read',
            args: [[['client_email', '=', email]]],
            kwargs: { 
              fields: ['client_name', 'client_email', 'adresse_chantier', 'type_portail', 'date_installation']
            }
          }
        })
      });

      const data = await rpcRes.json();
      return res.json({ installations: data.result || [] });
    }

    if (action === 'create_intervention') {
      const body = JSON.parse(req.body);
      // Création intervention
      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionId 
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            model: 'demex.intervention',
            method: 'create',
            args: [body],
            kwargs: {}
          }
        })
      });

      const data = await rpcRes.json();
      return res.json({ success: true, id: data.result });
    }

    return res.status(400).json({ error: 'Action inconnue' });

  } catch (err) {
    console.error('[SAV API Error]', err);
    return res.status(500).json({ error: err.message });
  }
}
