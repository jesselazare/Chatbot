/* =============================================
   BRADLEY v3 — RAG Engine
   backend/rag.js
   LangChain + FAISS + Groq Embeddings
   ============================================= */

import { ChatGroq }               from '@langchain/groq';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { MemoryVectorStore }       from 'langchain/vectorstores/memory';
import { Document }                from '@langchain/core/documents';
import { StringOutputParser }      from '@langchain/core/output_parsers';
import { ChatPromptTemplate }      from '@langchain/core/prompts';
import { createStuffDocumentsChain } from 'langchain/chains/combine_documents';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===========================
// EMBEDDINGS MAISON
// Groq ne fournit pas d'embeddings → on utilise
// une approche TF-IDF légère sans dépendance externe
// ===========================
class SimpleEmbeddings {
  constructor() {
    this.vocabulary = new Map();
    this.idf        = new Map();
    this.docCount   = 0;
  }

  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\sàâäéèêëîïôùûüç]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  _buildVocab(texts) {
    const dfMap = new Map();
    this.docCount = texts.length;

    texts.forEach(text => {
      const tokens = new Set(this._tokenize(text));
      tokens.forEach(t => {
        if (!this.vocabulary.has(t)) {
          this.vocabulary.set(t, this.vocabulary.size);
        }
        dfMap.set(t, (dfMap.get(t) || 0) + 1);
      });
    });

    dfMap.forEach((df, term) => {
      this.idf.set(term, Math.log((this.docCount + 1) / (df + 1)) + 1);
    });
  }

  _embed(text) {
    const tokens  = this._tokenize(text);
    const tf      = new Map();
    tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));

    const vec = new Array(Math.min(this.vocabulary.size, 512)).fill(0);
    tf.forEach((count, term) => {
      const idx = this.vocabulary.get(term);
      if (idx !== undefined && idx < vec.length) {
        vec[idx] = (count / tokens.length) * (this.idf.get(term) || 1);
      }
    });

    // Normalisation L2
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }

  async embedDocuments(texts) {
    this._buildVocab(texts);
    return texts.map(t => this._embed(t));
  }

  async embedQuery(text) {
    return this._embed(text);
  }
}

// ===========================
// STATE DU VECTORSTORE
// ===========================
let vectorStore  = null;
let embeddings   = new SimpleEmbeddings();
let docsMetadata = []; // {name, type, size, addedAt}

// ===========================
// SPLITTER
// ===========================
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize:    800,
  chunkOverlap: 100,
  separators: ['\n\n', '\n', '. ', ' ', ''],
});

// ===========================
// CHARGEMENT DES DOCUMENTS FIXES
// ===========================
export async function loadFixedDocuments() {
  const docsDir = path.join(__dirname, 'documents');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
    console.log('📁 Dossier documents/ créé. Ajoutes-y tes fichiers .txt ou .md');
    return 0;
  }

  const files = fs.readdirSync(docsDir).filter(f =>
    f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.json')
  );

  if (files.length === 0) {
    console.log('📁 Aucun document fixe trouvé dans backend/documents/');
    return 0;
  }

  const allDocs = [];
  for (const file of files) {
    const filePath = path.join(docsDir, file);
    const content  = fs.readFileSync(filePath, 'utf-8');
    const chunks   = await splitter.splitText(content);

    chunks.forEach((chunk, i) => {
      allDocs.push(new Document({
        pageContent: chunk,
        metadata: { source: file, chunk: i, type: 'fixed' },
      }));
    });

    docsMetadata.push({
      name: file, type: 'fixed',
      size: content.length,
      chunks: chunks.length,
      addedAt: new Date().toISOString(),
    });

    console.log(`  ✓ ${file} — ${chunks.length} chunks`);
  }

  await initVectorStore(allDocs);
  console.log(`📚 ${allDocs.length} chunks indexés depuis ${files.length} fichier(s) fixe(s)`);
  return files.length;
}

// ===========================
// INDEXATION D'UN UPLOAD
// ===========================
export async function indexUploadedFile(filename, content, mimetype) {
  let text = '';

  if (mimetype === 'application/pdf') {
    // pdf-parse
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const buffer   = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const parsed   = await pdfParse(buffer);
    text = parsed.text;
  } else {
    // TXT, MD, JSON
    text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content);
  }

  if (!text.trim()) throw new Error('Document vide ou illisible');

  const chunks = await splitter.splitText(text);
  const docs   = chunks.map((chunk, i) => new Document({
    pageContent: chunk,
    metadata: { source: filename, chunk: i, type: 'upload' },
  }));

  // Ajouter au vectorstore existant ou en créer un
  if (vectorStore) {
    await vectorStore.addDocuments(docs);
  } else {
    await initVectorStore(docs);
  }

  docsMetadata.push({
    name: filename, type: 'upload',
    size: text.length,
    chunks: chunks.length,
    addedAt: new Date().toISOString(),
  });

  console.log(`📄 Upload indexé: ${filename} — ${chunks.length} chunks`);
  return { chunks: chunks.length, characters: text.length };
}

// ===========================
// INIT VECTORSTORE
// ===========================
async function initVectorStore(docs) {
  const texts   = docs.map(d => d.pageContent);
  const vectors = await embeddings.embedDocuments(texts);

  // Reconstruction du vectorstore mémoire
  if (!vectorStore) {
    vectorStore = new MemoryVectorStore(embeddings);
  }
  await vectorStore.addDocuments(docs);
}

// ===========================
// RECHERCHE RAG
// ===========================
export async function retrieveContext(query, k = 4) {
  if (!vectorStore || docsMetadata.length === 0) return null;

  try {
    const results = await vectorStore.similaritySearchWithScore(query, k);
    if (!results || results.length === 0) return null;

    // Filtrer les résultats trop peu pertinents (score < 0.1)
    const relevant = results.filter(([_, score]) => score > 0.05);
    if (relevant.length === 0) return null;

    const context = relevant
      .map(([doc, score], i) => {
        const src = doc.metadata?.source || 'document';
        return `[Source: ${src}]\n${doc.pageContent}`;
      })
      .join('\n\n---\n\n');

    const sources = [...new Set(
      relevant.map(([doc]) => doc.metadata?.source).filter(Boolean)
    )];

    return { context, sources };
  } catch (err) {
    console.error('Erreur RAG retrieve:', err.message);
    return null;
  }
}

// ===========================
// INFOS SUR LES DOCS INDEXÉS
// ===========================
export function getIndexedDocuments() {
  return {
    documents: docsMetadata,
    totalChunks: docsMetadata.reduce((s, d) => s + (d.chunks || 0), 0),
    hasIndex: !!vectorStore && docsMetadata.length > 0,
  };
}

export function removeDocument(name) {
  docsMetadata = docsMetadata.filter(d => d.name !== name);
  // Note: MemoryVectorStore ne supporte pas la suppression sélective
  // il faudrait reconstruire — on laisse les chunks mais retire des metadata
}