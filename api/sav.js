// api/sav.js - API SAV pour Odoo (à mettre dans demex-tarif-proxy2)
export default async function handler(req, res) {
  // ══════════════════════════════════════════════════════════
  // CORS Configuration
  // ══════════════════════════════════════════════════════════
  const origin = req.headers.origin;
  const allowed = process.env.ALLOWED_ORIGIN?.split(',') || [];
  
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ══════════════════════════════════════════════════════════
  // Configuration Odoo
  // ══════════════════════════════════════════════════════════
  const odooUrl = process.env.ODOO_URL;
  const db = process.env.ODOO_DB;
  const username = process.env.ODOO_USERNAME;
  const apiKey = process.env.ODOO_API_KEY;

  if (!odooUrl || !db || !username || !apiKey) {
    return res.status(500).json({ 
      error: 'Variables Odoo manquantes',
      odoo_connected: false 
    });
  }

  const { action } = req.query;

  try {
    // ══════════════════════════════════════════════════════════
    // 1. AUTHENTIFICATION ODOO
    // ══════════════════════════════════════════════════════════
    console.log('[SAV] Authentification Odoo...');
    
    const authRes = await fetch(`${odooUrl}/web/session/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: Math.floor(Math.random() * 100000),
        params: { 
          db, 
          login: username, 
          password: apiKey 
        }
      })
    });

    const authData = await authRes.json();
    
    if (!authData.result || !authData.result.uid) {
      console.error('[SAV] Auth failed:', authData);
      return res.status(401).json({ 
        error: 'Authentification Odoo échouée',
        odoo_connected: false,
        details: authData.error || 'Invalid credentials'
      });
    }

    console.log('[SAV] Auth OK - UID:', authData.result.uid);

    // Récupération du cookie de session
    const cookies = authRes.headers.get('set-cookie');
    const sessionCookie = cookies ? cookies.split(';')[0] : '';

    // ══════════════════════════════════════════════════════════
    // 2. HEALTH CHECK
    // ══════════════════════════════════════════════════════════
    if (action === 'health') {
      return res.json({ 
        status: 'OK', 
        odoo_connected: true,
        odoo_user: authData.result.username,
        odoo_uid: authData.result.uid,
        timestamp: new Date().toISOString()
      });
    }

    // ══════════════════════════════════════════════════════════
    // 3. LISTER LES INSTALLATIONS D'UN CLIENT
    // ══════════════════════════════════════════════════════════
    if (action === 'installations') {
      const { email } = req.query;
      
      if (!email) {
        return res.status(400).json({ error: 'Email requis' });
      }

      console.log('[SAV] Recherche installations pour:', email);

      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionCookie
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          id: Math.floor(Math.random() * 100000),
          params: {
            model: 'demex.installation',
            method: 'search_read',
            args: [[['client_email', '=', email]]],
            kwargs: { 
              fields: [
                'client_name', 'client_email', 'adresse_chantier', 
                'type_portail', 'date_installation', 'reference_produit',
                'largeur_ouverture', 'hauteur', 'marque_motorisation',
                'garantie_fin', 'statut', 'notes'
              ],
              limit: 100
            }
          }
        })
      });

      const data = await rpcRes.json();

      if (data.error) {
        console.error('[SAV] RPC Error:', data.error);
        return res.status(500).json({ 
          error: 'Erreur Odoo RPC',
          details: data.error.data?.message || data.error.message
        });
      }

      console.log('[SAV] Installations trouvées:', data.result?.length || 0);

      return res.json({ 
        installations: data.result || [],
        count: data.result?.length || 0
      });
    }

    // ══════════════════════════════════════════════════════════
    // 4. LISTER LES INTERVENTIONS
    // ══════════════════════════════════════════════════════════
    if (action === 'interventions') {
      const { client_email, installation_id } = req.query;
      
      let domain = [];
      if (client_email) {
        domain.push(['client_email', '=', client_email]);
      }
      if (installation_id) {
        domain.push(['installation_id', '=', parseInt(installation_id)]);
      }

      console.log('[SAV] Recherche interventions:', domain);

      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionCookie
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          id: Math.floor(Math.random() * 100000),
          params: {
            model: 'demex.intervention',
            method: 'search_read',
            args: [domain],
            kwargs: { 
              fields: [
                'client_name', 'client_email', 'type_probleme', 
                'description', 'urgence', 'statut', 'date_planifiee',
                'technicien_name', 'date_debut', 'date_fin'
              ],
              limit: 100,
              order: 'date_planifiee desc'
            }
          }
        })
      });

      const data = await rpcRes.json();

      if (data.error) {
        console.error('[SAV] RPC Error:', data.error);
        return res.status(500).json({ 
          error: 'Erreur Odoo RPC',
          details: data.error.data?.message || data.error.message
        });
      }

      return res.json({ 
        interventions: data.result || [],
        count: data.result?.length || 0
      });
    }

    // ══════════════════════════════════════════════════════════
    // 5. CRÉER UNE INTERVENTION
    // ══════════════════════════════════════════════════════════
    if (action === 'create_intervention') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode POST requise' });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      console.log('[SAV] Création intervention:', body);

      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionCookie
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          id: Math.floor(Math.random() * 100000),
          params: {
            model: 'demex.intervention',
            method: 'create',
            args: [body],
            kwargs: {}
          }
        })
      });

      const data = await rpcRes.json();

      if (data.error) {
        console.error('[SAV] Create Error:', data.error);
        return res.status(500).json({ 
          error: 'Erreur création intervention',
          details: data.error.data?.message || data.error.message
        });
      }

      console.log('[SAV] Intervention créée - ID:', data.result);

      return res.json({ 
        success: true, 
        intervention_id: data.result,
        message: 'Intervention créée avec succès'
      });
    }

    // ══════════════════════════════════════════════════════════
    // 6. METTRE À JOUR UNE INTERVENTION
    // ══════════════════════════════════════════════════════════
    if (action === 'update_intervention') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode POST requise' });
      }

      const { id, values } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (!id || !values) {
        return res.status(400).json({ error: 'ID et values requis' });
      }

      console.log('[SAV] Update intervention ID:', id, values);

      const rpcRes = await fetch(`${odooUrl}/web/dataset/call_kw`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Cookie': sessionCookie
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          id: Math.floor(Math.random() * 100000),
          params: {
            model: 'demex.intervention',
            method: 'write',
            args: [[id], values],
            kwargs: {}
          }
        })
      });

      const data = await rpcRes.json();

      if (data.error) {
        console.error('[SAV] Update Error:', data.error);
        return res.status(500).json({ 
          error: 'Erreur mise à jour intervention',
          details: data.error.data?.message || data.error.message
        });
      }

      return res.json({ 
        success: true,
        message: 'Intervention mise à jour avec succès'
      });
    }

    // ══════════════════════════════════════════════════════════
    // Action inconnue
    // ══════════════════════════════════════════════════════════
    return res.status(400).json({ 
      error: 'Action inconnue',
      available_actions: [
        'health',
        'installations',
        'interventions', 
        'create_intervention',
        'update_intervention'
      ]
    });

  } catch (err) {
    console.error('[SAV API Error]', err);
    return res.status(500).json({ 
      error: 'Erreur serveur',
      message: err.message,
      odoo_connected: false
    });
  }
}
