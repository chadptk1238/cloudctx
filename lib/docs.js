import { readFileSync } from 'fs';
import { basename } from 'path';
import { getDb, getReadonlyDb, dbExists } from './db.js';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? httpsGet : httpGet;
    getter(url, { headers: { 'User-Agent': 'cloudctx/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

export async function ingestDoc(source, tags = '', title = '') {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  let content;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    content = await fetchUrl(source);
  } else {
    content = readFileSync(source, 'utf-8');
  }

  if (!title) {
    const firstLine = content.split('\n')[0].trim();
    title = firstLine.replace(/^#\s*/, '').trim() || basename(source, '.md');
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM docs WHERE source = ?').get(source);

  if (existing) {
    db.prepare('UPDATE docs SET title=?, content=?, tags=?, created_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(title, content, tags, existing.id);
    console.log(`Updated (id=${existing.id}): ${title} | ${content.length.toLocaleString()} chars | tags: ${tags || '(none)'}`);
  } else {
    const result = db.prepare('INSERT INTO docs (title, content, tags, source) VALUES (?, ?, ?, ?)')
      .run(title, content, tags, source);
    console.log(`Inserted (id=${result.lastInsertRowid}): ${title} | ${content.length.toLocaleString()} chars | tags: ${tags || '(none)'}`);
  }

  db.close();
}

export function listDocs() {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getReadonlyDb();
  const rows = db.prepare('SELECT id, title, tags, source, length(content) as size, created_at FROM docs ORDER BY id').all();
  db.close();

  if (!rows.length) {
    console.log('No docs in database.');
    return;
  }

  console.log(`${'ID'.padStart(4)}  ${'Title'.padEnd(40)}  ${'Tags'.padEnd(25)}  ${'Size'.padStart(8)}  Source`);
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(`${String(r.id).padStart(4)}  ${(r.title || '').slice(0, 40).padEnd(40)}  ${(r.tags || '').slice(0, 25).padEnd(25)}  ${String(r.size).padStart(8)}  ${(r.source || '').slice(0, 40)}`);
  }
}

export function searchDocs(query) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getReadonlyDb();
  const rows = db.prepare(`
    SELECT d.id, d.title, d.tags, substr(d.content, 1, 200) as preview
    FROM docs_fts f JOIN docs d ON f.rowid = d.id
    WHERE docs_fts MATCH ?
    ORDER BY rank LIMIT 10
  `).all(query);
  db.close();

  if (!rows.length) {
    console.log(`No docs matching: ${query}`);
    return;
  }

  for (const r of rows) {
    console.log(`[${r.id}] ${r.title} (${r.tags || 'no tags'})`);
    console.log(`    ${r.preview}...`);
    console.log('');
  }
}

export function deleteDoc(id) {
  if (!dbExists()) {
    console.error('No database found. Run: cloudctx init');
    process.exit(1);
  }

  const db = getDb();
  const row = db.prepare('SELECT title FROM docs WHERE id = ?').get(id);
  if (!row) {
    console.error(`No doc with id=${id}`);
    process.exit(1);
  }

  db.prepare('DELETE FROM docs WHERE id = ?').run(id);
  db.close();
  console.log(`Deleted: ${row.title} (id=${id})`);
}
