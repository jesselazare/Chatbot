/* =============================================
   BRADLEY v3 — Backend Express
   BackEnd/server.js
   ============================================= */

import express  from 'express';
import cors     from 'cors';
import multer   from 'multer';
import path     from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import {
  loadFixedDocuments,
  indexUploadedFile,
  retrieveContext,
  getIndexedDocuments,
  removeDocument,
} from './rag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app       = express();
const PORT      = process.env.PORT || 3000;
const GROQ_KEY  = process.env.GROQ_API_KEY;

if (!GROQ_KEY) {
  console.error('❌ GROQ_API_KEY manquante dans le fichier .env');
  process.exit(1);
}

// ===========================
// MIDDLEWARE
// ===========================
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir le frontend — dossier FrontEnd avec majuscule
app.use(express.static(path.join(__dirname, '../FrontEnd')));

// Upload en mémoire (max 20MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['application/pdf', 'text/plain', 'text/markdown',
                     'application/json', 'text/csv'];
    const extOk   = /\.(pdf|txt|md|json|csv)$/i.test(file.originalname);
    cb(null, allowed.includes(file.mimetype) || extOk);
  },
});

// ===========================
// ROUTE : CHAT (streaming)
// ===========================
app.post('/api/chat', async (req, res) => {
  const { messages, model = 'llama-3.3-70b-versatile',
          temperature = 0.7, memory = [] } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages requis' });
  }

  // Dernière question de l'utilisateur
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const query    = lastUser?.content || '';

  // RAG : récupérer le contexte pertinent
  let ragContext = null;
  if (query) {
    ragContext = await retrieveContext(query, 5);
  }

  // Construire le system prompt
  let systemContent = `Tu es BRADLEY, un assistant IA intelligent, précis et dynamique.
Tu réponds en français par défaut, sauf si l'utilisateur écrit dans une autre langue.
Ton ton est direct et efficace, à l'image du Paris Saint-Germain.
Tu utilises le Markdown quand c'est utile (code, listes, titres).`;

  // Mémoire utilisateur
  if (memory && memory.length > 0) {
    const facts = memory.map(m => `- ${m.key}: ${m.value}`).join('\n');
    systemContent += `\n\nInformations mémorisées sur l'utilisateur:\n${facts}`;
  }

  // Contexte RAG
  if (ragContext) {
    systemContent += `\n\n📚 CONTEXTE ISSU DE LA BASE DE DOCUMENTS:\n${ragContext.context}\n\nUtilise ce contexte pour répondre précisément. Cite les sources si pertinent.`;
  }

  // Headers pour le streaming SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Envoyer les sources RAG en premier
  if (ragContext?.sources?.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'sources', sources: ragContext.sources })}\n\n`);
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: 2048,
        stream:     true,
        messages: [
          { role: 'system', content: systemContent },
          ...messages,
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.error?.message })}\n\n`);
      return res.end();
    }

    // Pipe du stream Groq → client
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta  = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`);
          }
        } catch (_) {}
      }
    }

  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ===========================
// ROUTE : MÉMOIRE (extraction LLM)
// ===========================
app.post('/api/memory/extract', async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 5) return res.json({ items: [] });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model:       'llama-3.1-8b-instant',
        temperature: 0,
        max_tokens:  300,
        messages: [
          {
            role: 'system',
            content: `Tu es un extracteur d'informations personnelles.
Analyse le message et extrais UNIQUEMENT les informations personnelles importantes que l'utilisateur partage sur lui-même.
Exemples : prénom, âge, métier, ville, projet, stack technique, langages, centres d'intérêt, objectifs, formation, employeur, compétences.
Réponds UNIQUEMENT avec un tableau JSON valide, sans texte avant ou après.
Format: [{"key":"prénom","value":"Jesse","emoji":"👤"}]
Si aucune info personnelle: []`,
          },
          { role: 'user', content: text },
        ],
      }),
    });

    const data = await response.json();
    let raw    = data.choices?.[0]?.message?.content?.trim() || '[]';
    raw        = raw.replace(/```json|```/g, '').trim();
    const items = JSON.parse(raw);
    res.json({ items: Array.isArray(items) ? items : [] });

  } catch (_) {
    res.json({ items: [] });
  }
});

// ===========================
// ROUTE : UPLOAD DOCUMENT
// ===========================
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni' });

  try {
    const result = await indexUploadedFile(
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );
    res.json({
      success:  true,
      filename: req.file.originalname,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// ROUTE : LISTE DES DOCUMENTS
// ===========================
app.get('/api/documents', (_, res) => {
  res.json(getIndexedDocuments());
});

// ===========================
// ROUTE : SUPPRIMER UN DOCUMENT
// ===========================
app.delete('/api/documents/:name', (req, res) => {
  removeDocument(decodeURIComponent(req.params.name));
  res.json({ success: true });
});

// ===========================
// ROUTE : STATUS
// ===========================
app.get('/api/status', (_, res) => {
  const { hasIndex, totalChunks, documents } = getIndexedDocuments();
  res.json({
    status:      'ok',
    hasIndex,
    totalChunks,
    docCount:    documents.length,
    groqKeySet:  !!GROQ_KEY,
  });
});

// ===========================
// DÉMARRAGE
// ===========================
async function start() {
  console.log('\n🔵 BRADLEY v3 — PSG AI with RAG');
  console.log('================================');
  console.log('📚 Chargement des documents fixes...');

  const count = await loadFixedDocuments();
  console.log(`✓ ${count} fichier(s) fixe(s) indexé(s)\n`);

  app.listen(PORT, () => {
    console.log(`🚀 Serveur en ligne → http://localhost:${PORT}`);
    console.log(`📁 Mets tes docs dans BackEnd/documents/`);
    console.log(`🔑 Clé Groq: ${GROQ_KEY ? '✓ configurée' : '✗ manquante'}\n`);
  });
}

start();