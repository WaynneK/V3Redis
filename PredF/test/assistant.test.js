'use strict';
/*
 * Tests de l'Assistant IA hors réseau : lecture du Markdown, mise en page PDF, construction de la requête.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const Markdown = require('../lib/markdown.js');
const MdPdf = require('../lib/mdpdf.js');
const AI = require('../lib/ai.js');

const { describe, it } = test;

const SAMPLE = `# Rapport fusionné

Introduction avec du **gras**, de l'*italique*, un \`code\` et un nom_de_fichier.

## Points clés

- Premier point
- Deuxième point **important**
  - Sous-point
1. Étape une
2. Étape deux

> Une citation

| Élément | Montant | Échéance |
|---|---:|---|
| Loyer | 1 200 € | 01/11 |
| Énergie | 340 € | 15/11 |

---

\`\`\`
code brut
\`\`\`
`;

describe('Markdown', () => {
  it('découpe les blocs', () => {
    const types = Markdown.parse(SAMPLE).map((b) => b.type);
    assert.deepEqual(types, ['h', 'p', 'h', 'ul', 'ol', 'quote', 'table', 'hr', 'code']);
  });

  it('lit le gras, l\'italique et le code en ligne', () => {
    const p = Markdown.parse(SAMPLE)[1].inlines;
    assert.ok(p.some((r) => r.bold && r.text === 'gras'));
    assert.ok(p.some((r) => r.italic && r.text === 'italique'));
    assert.ok(p.some((r) => r.code && r.text === 'code'));
    assert.ok(p.map((r) => r.text).join('').includes('nom_de_fichier'), 'souligné dans un mot : pas d\'italique');
  });

  it('listes imbriquées, tableaux', () => {
    const blocks = Markdown.parse(SAMPLE);
    const ul = blocks[3];
    assert.deepEqual(ul.items.map((i) => i.level), [0, 0, 1]);
    const table = blocks[6];
    assert.equal(table.head.length, 3);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[1][1].map((r) => r.text).join(''), '340 €');
  });

  it('titre et texte brut', () => {
    assert.equal(Markdown.title(SAMPLE), 'Rapport fusionné');
    const plain = Markdown.toPlain(SAMPLE);
    assert.ok(plain.startsWith('RAPPORT FUSIONNÉ'));
    assert.ok(!plain.includes('**'));
    assert.ok(plain.includes('• Premier point'));
    assert.ok(plain.includes('Loyer | 1 200 € | 01/11'));
  });

  it('texte vide ou inattendu', () => {
    assert.deepEqual(Markdown.parse(''), []);
    assert.deepEqual(Markdown.parse(null), []);
    assert.equal(Markdown.parse('Juste du texte').length, 1);
  });
});

describe('Mise en page PDF', () => {
  it('crée un PDF lisible avec la police du système', async () => {
    const long = `${SAMPLE}\n\n${Array.from({ length: 80 }, (_, i) => `Paragraphe ${i + 1} : ${'texte '.repeat(40)}“guillemets” — tiret ≥ 3 → flèche.`).join('\n\n')}`;
    const bytes = await MdPdf.markdownToPdf(long);
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 3, 'texte long : plusieurs pages');
    assert.equal(doc.getTitle(), 'Rapport fusionné');
    assert.equal(Math.round(doc.getPage(0).getWidth()), 595);
  });

  it('repli sur les polices standard (caractères remplacés, pas d\'erreur)', async () => {
    const bytes = await MdPdf.markdownToPdf('# Titre ≥ → ✓\n\nTexte 漢字 et émoji 🎉', { fontFiles: null });
    // fontFiles: null → systemFonts() est appelé par défaut ; on force le repli avec un chemin inexistant
    const fallback = await MdPdf.markdownToPdf('# Titre ≥ → ✓\n\nTexte 漢字', { fontFiles: { regular: 'Z:/absent.ttf', bold: 'Z:/absent.ttf', italic: 'Z:/absent.ttf', mono: 'Z:/absent.ttf' } });
    assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
    assert.ok((await PDFDocument.load(fallback)).getPageCount() >= 1);
  });

  it('mot plus long que la ligne', async () => {
    const bytes = await MdPdf.markdownToPdf(`# T\n\n${'x'.repeat(600)}`);
    assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  });
});

describe('Requête de l\'Assistant', () => {
  const pdf = { name: 'a.pdf', kind: 'pdf', type: 'pdf', bytes: new Uint8Array([37, 80, 68, 70]), pageCount: 3 };
  const img = { name: 'b.png', kind: 'image', type: 'png', bytes: new Uint8Array([1, 2, 3]) };

  it('documents nommés puis consigne', () => {
    const content = AI.buildContent([pdf, img], 'Fusionne');
    assert.deepEqual(content.map((b) => b.type), ['text', 'document', 'text', 'image', 'text']);
    assert.equal(content[1].source.media_type, 'application/pdf');
    assert.equal(content[1].source.data, Buffer.from(pdf.bytes).toString('base64'));
    assert.equal(content[3].source.media_type, 'image/png');
    assert.equal(content.at(-1).text, 'Consigne : Fusionne');
  });

  it('refuse les documents trop lourds ou trop longs', () => {
    assert.throws(() => AI.buildContent([{ ...pdf, pageCount: 700 }], 'x'), /600/);
    assert.throws(() => AI.buildContent([{ ...pdf, bytes: new Uint8Array(24 * 1024 * 1024) }], 'x'), /trop lourds/);
  });

  it('modèle par défaut : Claude Opus 5.5', () => {
    assert.equal(AI.MODELS[0].id, 'claude-opus-5-5');
  });
});

describe('IA locale (Ollama)', () => {
  const LocalAI = require('../lib/localai.js');

  it('n\'accepte que des adresses de cet ordinateur', () => {
    assert.equal(LocalAI.checkUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.equal(LocalAI.checkUrl('http://localhost:11434/'), 'http://localhost:11434');
    assert.equal(LocalAI.checkUrl(undefined), LocalAI.DEFAULT_URL);
    for (const bad of ['http://192.168.1.20:11434', 'https://ollama.example.com', 'file:///c:/x']) assert.throws(() => LocalAI.checkUrl(bad), /cet ordinateur/, bad);
  });

  it('prompt : documents nommés puis consigne', () => {
    const p = LocalAI.buildPrompt([{ name: 'a.pdf', text: 'Bonjour' }, { name: 'scan.pdf', text: '' }], 'Résume');
    assert.ok(p.includes('Document 1 : « a.pdf »'));
    assert.ok(p.includes('Bonjour'));
    assert.ok(p.includes('(aucun texte'));
    assert.ok(p.trim().endsWith('Résume'));
  });

  it('refuse les documents trop longs sans contacter le serveur', async () => {
    const { done } = LocalAI.run({ url: 'http://127.0.0.1:9', model: 'm', system: 's', docs: [{ name: 'gros.pdf', text: 'mot '.repeat(40000) }], instruction: 'x', onText: () => {} });
    const res = await done;
    assert.equal(res.ok, false);
    assert.match(res.error, /trop longs/);
  });

  it('serveur absent : état « non lancé »', async () => {
    const s = await LocalAI.status('http://127.0.0.1:9');
    assert.equal(s.running, false);
  });

  it('modèles conseillés', () => {
    assert.ok(LocalAI.RECOMMENDED.length >= 2);
    assert.ok(LocalAI.RECOMMENDED.every((m) => /^[\w.-]+:[\w.-]+$/.test(m.id)));
  });
});
