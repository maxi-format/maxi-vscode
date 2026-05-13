'use strict';

const fs                    = require('fs');
const path                  = require('path');
const { fileURLToPath }     = require('url');
const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CompletionItemKind,
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');

// ---------------------------------------------------------------------------
// Semantic token legend
// ---------------------------------------------------------------------------

const TOKEN_TYPES     = ['enumMember', 'parameter', 'number', 'variable', 'string', 'decorator'];
const TOKEN_MODIFIERS = ['declaration'];

const TT_ENUM_MEMBER = 0;
const TT_PARAMETER   = 1;
const TT_NUMBER      = 2;
const TT_VARIABLE    = 3;
const TT_STRING      = 4;
const TT_NULL        = 5;

const MOD_NONE        = 0;
const MOD_DECLARATION = 1;

// ---------------------------------------------------------------------------
// LSP connection
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

// Per-URI document model cache: uri → ParsedDocument
const docCache = new Map();

documents.onDidChangeContent(change => {
  docCache.delete(change.document.uri);
  const pd   = getOrParse(change.document);
  const diag = computeDiagnostics(pd);
  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: diag });
});

documents.onDidClose(event => {
  docCache.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: false },
    completionProvider: {
      resolveProvider: false,
      triggerCharacters: ['(', '|', ':'],
    },
    semanticTokensProvider: {
      legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS },
      full: true,
    },
  },
}));

connection.onRequest('textDocument/semanticTokens/full', (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const pd = getOrParse(doc);
  return buildSemanticTokens(pd);
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const pd = getOrParse(doc);
  return computeHover(pd, params.position);
});

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const pd = getOrParse(doc);
  return computeDefinition(pd, doc.uri, params.position);
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const pd = getOrParse(doc);
  return computeCompletion(pd, doc, params.position);
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const pd = getOrParse(doc);
  return computeReferences(pd, doc.uri, params.position, params.context);
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const pd = getOrParse(doc);
  return computeRename(pd, doc, params.position, params.newName);
});

documents.listen(connection);
connection.listen();

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/**
 * ParsedDocument holds everything derived from parsing a .maxi or .mxs file.
 *
 * @typedef {{
 *   lines:    string[],
 *   sepLine:  number,          // index of ###, or -1
 *   schema:   Map<string, TypeDef>,
 *   records:  RecordEntry[],   // all data records with position info
 *   recIndex: Map<string, Map<string, RecordEntry>>,  // alias → id → entry
 * }} ParsedDocument
 *
 * @typedef {{
 *   alias:    string,
 *   fields:   FieldDef[],
 *   parents:  string[],
 *   defLine:  number,          // 0-based line of the type definition
 *   _resolved: boolean,
 * }} TypeDef
 *
 * @typedef {{
 *   name:     string,
 *   typeExpr: string|null,
 *   isId:     boolean,
 * }} FieldDef
 *
 * @typedef {{
 *   alias:    string,
 *   lineIdx:  number,
 *   idValue:  string|null,
 *   fields:   { value: string, lineIdx: number, charStart: number, charEnd: number }[],
 * }} RecordEntry
 */

function getOrParse(doc) {
  if (docCache.has(doc.uri)) return docCache.get(doc.uri);
  const pd = parseDocument(doc);
  docCache.set(doc.uri, pd);
  return pd;
}

/** Full parse of a TextDocument into a ParsedDocument. */
function parseDocument(doc) {
  const lines   = doc.getText().split(/\r?\n/);
  const sepLine = findSeparator(lines);

  // Parse inline schema (lines 0..sepLine, or entire file if no ###)
  const schemaEnd = sepLine === -1 ? lines.length : sepLine;
  const schema    = parseSchema(lines, schemaEnd, doc.uri);

  // Parse data records
  const records  = [];
  const recIndex = new Map(); // alias → Map<idValue, RecordEntry>

  if (sepLine !== -1) {
    let i = sepLine + 1;
    while (i < lines.length) {
      const line = lines[i];
      const m    = line.match(/^([A-Z][A-Za-z0-9_-]*)\(/);
      if (!m) { i++; continue; }

      const alias   = m[1];
      const typeDef = schema.get(alias);

      // Collect full record (multiline)
      const recordLines = [{ text: line, lineIdx: i }];
      let depth = netDepth(line);
      let j = i + 1;
      while (depth > 0 && j < lines.length) {
        recordLines.push({ text: lines[j], lineIdx: j });
        depth += netDepth(lines[j]);
        j++;
      }

      const entry = buildRecordEntry(alias, recordLines, m[0].length - 1, typeDef);
      records.push(entry);

      if (entry.idValue !== null) {
        if (!recIndex.has(alias)) recIndex.set(alias, new Map());
        recIndex.get(alias).set(entry.idValue, entry);
      }

      i = j;
    }
  }

  return { lines, sepLine, schema, records, recIndex };
}

function findSeparator(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '###') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Schema parser (with external @schema file loading)
// ---------------------------------------------------------------------------

/**
 * Parse schema lines and load any @schema: directives.
 * Returns a Map<alias, TypeDef>.
 */
function parseSchema(lines, schemaEnd, docUri) {
  const schema = new Map();

  // Load @schema: imports first
  for (let i = 0; i < schemaEnd; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('@schema:')) continue;
    const schemaPath = line.slice('@schema:'.length).trim();
    // Only handle local file paths (not http://)
    if (/^https?:\/\//.test(schemaPath)) continue;
    loadExternalSchema(schemaPath, docUri, schema);
  }

  // Parse inline type definitions
  let i = 0;
  while (i < schemaEnd) {
    const line = lines[i].trim();

    if (!line || line.startsWith('#') || line.startsWith('@')) { i++; continue; }
    if (!line.match(/^[A-Z][A-Za-z0-9_-]*(?=:|<|\()/)) { i++; continue; }

    const defLine = i;
    let fullDef   = line;
    let depth     = netDepth(line);
    i++;

    while (i < schemaEnd && depth > 0) {
      const next = lines[i].trim();
      fullDef += next;
      depth   += netDepth(next);
      i++;
    }

    parseTypeDef(fullDef, schema, defLine);
  }

  resolveInheritance(schema);
  return schema;
}

/**
 * Load and parse an external .mxs schema file, merging into schema.
 * schemaPath is relative to the directory of docUri.
 */
function loadExternalSchema(schemaPath, docUri, schema) {
  let absPath = '(unknown)';
  try {
    const docDir = path.dirname(uriToFsPath(docUri));
    absPath      = path.resolve(docDir, schemaPath);
    const text   = fs.readFileSync(absPath, 'utf8');
    const lines  = text.split(/\r?\n/);

    // External .mxs files may themselves import others
    const nestedUri = fsPathToUri(absPath);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('@schema:')) continue;
      const nested = line.slice('@schema:'.length).trim();
      if (/^https?:\/\//.test(nested)) continue;
      loadExternalSchema(nested, nestedUri, schema);
    }

    // Parse type definitions from the external file
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('@')) { i++; continue; }
      if (!line.match(/^[A-Z][A-Za-z0-9_-]*(?=:|<|\()/)) { i++; continue; }

      const defLine = i;
      let fullDef   = line;
      let depth     = netDepth(line);
      i++;

      while (i < lines.length && depth > 0) {
        const next = lines[i].trim();
        fullDef += next;
        depth   += netDepth(next);
        i++;
      }

      parseTypeDef(fullDef, schema, defLine, absPath);
    }
  } catch (err) {
    connection.console.error('[maxi] failed to load external schema ' + absPath + ': ' + err.message);
  }
}

function uriToFsPath(uri) {
  // Use Node.js built-in for correct Windows path handling (file:///C:/... → C:\...)
  return fileURLToPath(uri);
}

function fsPathToUri(fsPath) {
  // Normalise backslashes then build a proper file URI
  const normalised = fsPath.replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(normalised)
    ? 'file:///' + normalised
    : 'file://'  + normalised;
}

/** Net paren/bracket/brace depth change for a line, ignoring quoted strings. */
function netDepth(text) {
  let d = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
  }
  return d;
}

/**
 * Parse one (possibly multiline-joined) type definition into schema.
 * defLine is the 0-based source line number of the definition start.
 * sourceFile (optional) is the absolute path of the source file (for external schemas).
 */
function parseTypeDef(defText, schema, defLine, sourceFile) {
  const aliasMatch = defText.match(/^([A-Z][A-Za-z0-9_-]*)/);
  if (!aliasMatch) return;
  const alias = aliasMatch[1];

  const parenStart = defText.indexOf('(');
  if (parenStart === -1) return;

  const parents = [];
  const beforeParen = defText.slice(0, parenStart);
  const pm = beforeParen.match(/<([^>]+)>/);
  if (pm) {
    for (const p of pm[1].split(',')) {
      const t = p.trim();
      if (t) parents.push(t);
    }
  }

  let depth = 0, parenEnd = -1;
  for (let i = parenStart; i < defText.length; i++) {
    if (defText[i] === '(') depth++;
    else if (defText[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break; } }
  }
  if (parenEnd === -1) return;

  const fieldListText = defText.slice(parenStart + 1, parenEnd);
  const fields = splitDepthZero(fieldListText, '|')
    .map(f => parseFieldDef(f.trim()))
    .filter(Boolean);

  // Don't overwrite inline definitions with imported ones
  if (!schema.has(alias)) {
    schema.set(alias, { alias, fields, parents, defLine: defLine ?? 0, sourceFile: sourceFile ?? null, _resolved: false });
  }
}

function splitDepthZero(text, sep) {
  const parts = [];
  let depth = 0, inStr = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseFieldDef(fieldText) {
  if (!fieldText) return null;
  const nameMatch = fieldText.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const rest = fieldText.slice(name.length);

  let typeExpr = null;
  if (rest.startsWith(':')) typeExpr = extractTypeExpr(rest.slice(1));

  const constraintMatch = rest.match(/\(([^)]*)\)/);
  const isId      = name === 'id' ||
    (constraintMatch != null && /\bid\b/.test(constraintMatch[1]));
  const required  = constraintMatch != null &&
    /(?:^|,)\s*!\s*(?:,|$)/.test(constraintMatch[1]);
  const hasDefault = fieldHasDefault(rest);

  return { name, typeExpr, isId, required, hasDefault };
}

/** Returns true if field text contains a default value assignment (= outside brackets). */
function fieldHasDefault(rest) {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth--; continue; }
    if (ch === '=' && depth === 0) {
      const prev = i > 0 ? rest[i - 1] : '';
      if (prev !== '>' && prev !== '<' && prev !== '!') return true;
    }
  }
  return false;
}

function extractTypeExpr(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' || ch === '<') depth++;
    else if (ch === ']' || ch === '>') depth--;
    else if (depth === 0 && (ch === '(' || ch === '=' || ch === '|' || ch === ')')) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function resolveInheritance(schema) {
  for (const alias of schema.keys()) resolveType(alias, schema, new Set());
}

function resolveType(alias, schema, visited) {
  const td = schema.get(alias);
  if (!td || td._resolved) return;
  if (visited.has(alias)) return;
  visited.add(alias);

  const inherited = [];
  for (const parent of td.parents) {
    resolveType(parent, schema, visited);
    const pd = schema.get(parent);
    if (pd) inherited.push(...pd.fields);
  }
  td.fields = [...inherited, ...td.fields];
  td._resolved = true;
}

// ---------------------------------------------------------------------------
// Record entry builder
// ---------------------------------------------------------------------------

/**
 * Build a RecordEntry by scanning all field values from the record lines.
 * Stores each field value with its exact character range for hover hit-testing.
 */
function buildRecordEntry(alias, recordLines, parenOffset, typeDef) {
  const fields   = typeDef ? typeDef.fields : [];
  const result   = { alias, lineIdx: recordLines[0].lineIdx, idValue: null, fieldValues: [] };

  let fieldIdx      = 0;
  let depth         = 0;
  let inStr         = false;

  // fieldStart points to where the current field's content begins.
  // After the opening '(' on line 0, the first field starts at parenOffset+1.
  // If that position is at or past end-of-line (e.g. "O(\n"), advance to line 1 col 0.
  let fieldStartRli = 0;
  let fieldStartCi  = parenOffset + 1;
  // Advance fieldStart past a trailing newline on the opening line
  if (fieldStartCi >= recordLines[0].text.length && recordLines.length > 1) {
    fieldStartRli = 1;
    fieldStartCi  = 0;
  }

  function commitField(endRli, endCi) {
    const lineText = recordLines[fieldStartRli].text;
    const lineIdx  = recordLines[fieldStartRli].lineIdx;
    const raw      = lineText.slice(fieldStartCi, endCi);
    const trimmed  = raw.trim();
    const leadWS   = raw.length - raw.trimStart().length;

    result.fieldValues.push({
      value:     trimmed,
      lineIdx,
      charStart: fieldStartCi + leadWS,
      charEnd:   fieldStartCi + leadWS + trimmed.length,
      crossLine: fieldStartRli !== endRli,
    });

    // Track id value for the record index
    const field = fields[fieldIdx];
    if (field && field.isId && trimmed && trimmed !== '~') {
      result.idValue = trimmed;
    }
    fieldIdx++;
  }

  for (let rli = 0; rli < recordLines.length; rli++) {
    const text    = recordLines[rli].text;
    const startCi = (rli === 0) ? parenOffset : 0;

    for (let ci = startCi; ci < text.length; ci++) {
      const ch = text[ci];

      if (inStr) {
        if (ch === '\\') { ci++; continue; }
        if (ch === '"')  inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (rli === 0 && ci === parenOffset) continue; // skip opening '('

      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) { commitField(rli, ci); return result; }
        depth--;
        continue;
      }
      if (ch === '|' && depth === 0) {
        commitField(rli, ci);
        fieldStartRli = rli;
        fieldStartCi  = ci + 1;
        // If the pipe is the last char on this line, next field starts on the next line
        if (fieldStartCi >= recordLines[rli].text.length && rli + 1 < recordLines.length) {
          fieldStartRli = rli + 1;
          fieldStartCi  = 0;
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/**
 * Type annotation → human-readable hint.
 */
const ANNOTATION_HINTS = {
  date:      'date (YYYY-MM-DD)',
  datetime:  'datetime (ISO 8601)',
  time:      'time (HH:MM:SS)',
  email:     'email address',
  url:       'URL',
  uuid:      'UUID',
  base64:    'base64-encoded bytes',
  hex:       'hex-encoded bytes',
  timestamp: 'Unix timestamp (seconds)',
};

/**
 * Format a typeExpr for display in a hover tooltip.
 * e.g.  "str@email"         → "`str` *(email address)*"
 *       "enum[a,b,c]"       → "`enum` [a, b, c]"
 *       "int"               → "`int`"
 *       "U"  (object ref)   → "`U` (object reference)"
 */
function formatTypeExpr(te) {
  if (!te) return '`str`'; // default type

  // Detect @annotation
  const atIdx = te.indexOf('@');
  let base = te, annot = null;
  if (atIdx !== -1) {
    base  = te.slice(0, atIdx);
    annot = te.slice(atIdx + 1);
  }

  // Strip trailing [] array marker for display
  const isArray = base.endsWith('[]');
  if (isArray) base = base.slice(0, -2);

  let display;
  if (base.startsWith('enum')) {
    // enum[a:admin,e:editor] → `enum` [a → admin, e → editor]
    const inner = base.match(/\[([^\]]*)\]/);
    if (inner) {
      const items = inner[1].split(',').map(s => {
        s = s.trim();
        const c = s.indexOf(':');
        if (c >= 0) {
          const alias = s.slice(0, c), val = s.slice(c + 1);
          return alias === val ? alias : alias + ' → ' + val;
        }
        return s;
      }).filter(Boolean);
      display = '`enum` [' + items.join(', ') + ']';
    } else {
      display = '`enum`';
    }
  } else if (/^[A-Z]/.test(base)) {
    display = '`' + base + '` *(object reference)*';
  } else {
    display = '`' + base + '`';
  }

  if (annot && ANNOTATION_HINTS[annot]) display += ' *(' + ANNOTATION_HINTS[annot] + ')*';
  if (isArray) display += '[]';
  return display;
}

/**
 * Format a full type definition as a Markdown hover block.
 * Used when hovering the alias in a record or in the schema.
 */
function formatTypeDef(typeDef) {
  let md = '**' + typeDef.alias + '**';
  if (typeDef.parents && typeDef.parents.length) {
    md += ' *extends* ' + typeDef.parents.join(', ');
  }
  md += '\n\n';
  md += '| Field | Type |\n|---|---|\n';
  for (const f of typeDef.fields) {
    md += '| `' + f.name + '`' + (f.isId ? ' *(id)*' : '') + ' | ' + formatTypeExpr(f.typeExpr) + ' |\n';
  }
  return md;
}

/**
 * Format a RecordEntry as a summary line for hover tooltips on references.
 * Shows up to the first 4 field values to give context.
 */
function formatRecordSummary(entry, typeDef) {
  const preview = entry.fieldValues
    .slice(0, 4)
    .map((fv, i) => {
      const name = typeDef && typeDef.fields[i] ? typeDef.fields[i].name : String(i);
      return '`' + name + '`: ' + (fv.value || '*null*');
    })
    .join('  \n');
  const more = entry.fieldValues.length > 4 ? '  \n*…' + (entry.fieldValues.length - 4) + ' more fields*' : '';
  return '**' + entry.alias + '** record\n\n' + preview + more;
}

// ---------------------------------------------------------------------------
// Go to Definition
// ---------------------------------------------------------------------------

/**
 * Return a LSP Location for a TypeDef (same file or external .mxs).
 */
function typeDefLocation(td, docUri) {
  const uri   = td.sourceFile ? fsPathToUri(td.sourceFile) : docUri;
  const range = { start: { line: td.defLine, character: 0 },
                  end:   { line: td.defLine, character: 0 } };
  return { uri, range };
}

/**
 * Find a schema alias whose token sits under column `col` in `line`.
 * Returns the TypeDef or null.
 */
function findAliasUnderCursor(line, col, schema) {
  for (const [alias, td] of schema) {
    let idx = 0;
    while ((idx = line.indexOf(alias, idx)) !== -1) {
      const end    = idx + alias.length;
      const before = idx === 0 ? '' : line[idx - 1];
      const after  = end < line.length ? line[end] : '';
      if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
        if (col >= idx && col <= end) return td;
      }
      idx = end;
    }
  }
  return null;
}

/** Main definition handler. */
function computeDefinition(pd, docUri, pos) {
  const { lines, sepLine, schema, records, recIndex } = pd;
  const line = lines[pos.line];
  if (!line) return null;
  const col = pos.character;

  // ── SCHEMA SECTION ──────────────────────────────────────────────────────
  if (sepLine === -1 || pos.line < sepLine) {
    const td = findAliasUnderCursor(line, col, schema);
    if (td) return typeDefLocation(td, docUri);
    return null;
  }

  // ── DATA SECTION ─────────────────────────────────────────────────────────

  // 1. Cursor on alias at start of record → jump to type definition
  const aliasMatch = line.match(/^([A-Z][A-Za-z0-9_-]*)\(/);
  if (aliasMatch && col < aliasMatch[1].length) {
    const td = schema.get(aliasMatch[1]);
    if (td) return typeDefLocation(td, docUri);
  }

  // 2. Cursor on a field value in a record
  const record = records.find(r =>
    r.lineIdx === pos.line ||
    r.fieldValues.some(fv => fv.lineIdx === pos.line)
  );
  if (!record) return null;

  const typeDef = schema.get(record.alias);
  if (!typeDef) return null;

  const fvIdx = record.fieldValues.findIndex(fv =>
    fv.lineIdx === pos.line && col >= fv.charStart && col <= fv.charEnd
  );
  if (fvIdx === -1) return null;

  const fv    = record.fieldValues[fvIdx];
  const field = typeDef.fields[fvIdx];
  if (!field) return null;

  // Object-typed field → jump to the referenced record
  const te = field.typeExpr;
  if (te && /^[A-Z]/.test(te) && fv.value && fv.value !== '~') {
    const refMap   = recIndex.get(te);
    const refEntry = refMap && refMap.get(fv.value);
    if (refEntry) {
      return {
        uri:   docUri,
        range: { start: { line: refEntry.lineIdx, character: 0 },
                 end:   { line: refEntry.lineIdx, character: 0 } },
      };
    }
  }

  return null;
}

/** Main hover handler. */
function computeHover(pd, pos) {
  const { lines, sepLine, schema, records, recIndex } = pd;
  const line = lines[pos.line];
  if (!line) return null;

  // ── Hovering in the SCHEMA section (above ### or in .mxs file) ──────────
  if (sepLine === -1 || pos.line < sepLine) {
    return hoverInSchema(line, pos, schema);
  }

  // ── Hovering in the DATA section (below ###) ────────────────────────────
  return hoverInData(line, pos, pd);
}

/** Hover inside the schema section — show type definition on alias. */
function hoverInSchema(line, pos, schema) {
  // Match any uppercase alias at the cursor position
  const col = pos.character;
  for (const [alias, td] of schema) {
    // Find all occurrences of the alias in the line
    let idx = 0;
    while ((idx = line.indexOf(alias, idx)) !== -1) {
      const end = idx + alias.length;
      // Only match if it's a word boundary (not mid-word)
      const before = idx === 0 ? '' : line[idx - 1];
      const after  = end < line.length ? line[end] : '';
      if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
        if (col >= idx && col <= end) {
          return { contents: { kind: 'markdown', value: formatTypeDef(td) } };
        }
      }
      idx = end;
    }
  }
  return null;
}

/** Hover inside the data section — show field info or type def or reference target. */
function hoverInData(line, pos, pd) {
  const { schema, records, recIndex } = pd;
  const col = pos.character;

  // Find which record this line belongs to
  const record = records.find(r =>
    r.lineIdx === pos.line ||
    r.fieldValues.some(fv => fv.lineIdx === pos.line)
  );

  // Hovering over the alias at the start of a record line
  const aliasMatch = line.match(/^([A-Z][A-Za-z0-9_-]*)\(/);
  if (aliasMatch && col < aliasMatch[1].length) {
    const td = schema.get(aliasMatch[1]);
    if (td) return { contents: { kind: 'markdown', value: formatTypeDef(td) } };
  }

  if (!record) return null;

  const typeDef = schema.get(record.alias);
  if (!typeDef) return null;

  // Find which field value the cursor is inside
  const fvIdx = record.fieldValues.findIndex(fv =>
    fv.lineIdx === pos.line && col >= fv.charStart && col <= fv.charEnd
  );
  if (fvIdx === -1) return null;

  const fv    = record.fieldValues[fvIdx];
  const field = typeDef.fields[fvIdx];
  if (!field) return null;

  // For object-typed fields — show what the reference points to
  const te = field.typeExpr;
  if (te && /^[A-Z]/.test(te) && fv.value && fv.value !== '~') {
    const refTypeDef = schema.get(te);
    const refMap     = recIndex.get(te);
    const refEntry   = refMap && refMap.get(fv.value);

    let md = '**`' + field.name + '`** · ' + formatTypeExpr(te) + '\n\n';
    if (refEntry) {
      md += '→ ' + formatRecordSummary(refEntry, refTypeDef);
    } else {
      md += '*Reference `' + fv.value + '` not found in this file*';
    }
    return { contents: { kind: 'markdown', value: md } };
  }

  // Regular field — show name and type
  let md = '**`' + field.name + '`** · ' + formatTypeExpr(te);
  if (field.isId) md += '\n\n*(record identifier)*';

  // For enum fields with aliases, show what this wire token expands to
  if (te && te.startsWith('enum')) {
    const entries = enumEntries(te.replace(/\[\]$/, '').split('@')[0]);
    if (entries) {
      const hit = entries.find(e => e.alias === fv.value || e.value === fv.value);
      if (hit && hit.alias !== hit.value) {
        md += `\n\nWire token \`${hit.alias}\` → full value \`${hit.value}\``;
      }
    }
  }

  return { contents: { kind: 'markdown', value: md } };
}

// ---------------------------------------------------------------------------
// Semantic tokens
// ---------------------------------------------------------------------------

function classifyField(field) {
  if (field.isId) return { tt: TT_ENUM_MEMBER, mod: MOD_DECLARATION };

  const te = field.typeExpr;
  if (!te) return null;

  const noArray  = te.endsWith('[]') ? te.slice(0, -2) : te;
  const baseType = noArray.split('@')[0];

  if (baseType.startsWith('enum')) return { tt: TT_ENUM_MEMBER, mod: MOD_NONE };
  if (baseType === 'bool')         return { tt: TT_PARAMETER,   mod: MOD_NONE };
  if (baseType === 'int'   ||
      baseType === 'float' ||
      baseType === 'decimal')      return { tt: TT_NUMBER,      mod: MOD_NONE };
  if (baseType === 'bytes')        return { tt: TT_STRING,      mod: MOD_NONE };
  if (baseType === 'str' ||
      baseType === 'map')          return null;
  if (/^[A-Z]/.test(baseType))    return { tt: TT_VARIABLE,    mod: MOD_NONE };

  return null;
}

class TokensBuilder {
  constructor() { this._tokens = []; }
  push(line, char, len, type, mods) { this._tokens.push({ line, char, len, type, mods }); }
  build() {
    this._tokens.sort((a, b) => a.line !== b.line ? a.line - b.line : a.char - b.char);
    const data = [];
    let prevLine = 0, prevChar = 0;
    for (const t of this._tokens) {
      const dl = t.line - prevLine;
      const dc = dl === 0 ? t.char - prevChar : t.char;
      data.push(dl, dc, t.len, t.type, t.mods);
      prevLine = t.line; prevChar = t.char;
    }
    return { data };
  }
}

function buildSemanticTokens(pd) {
  const { schema, records } = pd;
  const builder = new TokensBuilder();

  for (const record of records) {
    const typeDef = schema.get(record.alias);
    if (!typeDef) continue;

    record.fieldValues.forEach((fv, idx) => {
      if (fv.crossLine) return; // skip values split across lines
      const field = typeDef.fields[idx];
      if (!field) return;

      const { value, lineIdx, charStart } = fv;
      if (!value) return;

      if (value === '~') {
        builder.push(lineIdx, charStart, 1, TT_NULL, MOD_NONE);
        return;
      }

      const firstCh = value[0];
      if (firstCh === '"' ||
          firstCh === '(' || firstCh === '[' || firstCh === '{') return;

      const cls = classifyField(field);
      if (!cls) return;

      builder.push(lineIdx, charStart, value.length, cls.tt, cls.mod);
    });
  }

  return builder.build();
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Make an LSP Diagnostic object. */
function makeDiag(line, character, length, message, severity) {
  return {
    range: {
      start: { line, character },
      end:   { line, character: character + Math.max(length, 1) },
    },
    message,
    severity,
    source: 'maxi',
  };
}

/**
 * Detect an inheritance cycle starting from `startAlias`.
 * Returns the cycle path array (e.g. ['A','B','A']) or null.
 */
function findInheritanceCycle(startAlias, schema) {
  function dfs(alias, path) {
    const td = schema.get(alias);
    if (!td) return null;
    for (const parent of td.parents) {
      if (path.includes(parent)) return [...path, parent];
      const result = dfs(parent, [...path, parent]);
      if (result) return result;
    }
    return null;
  }
  const td = schema.get(startAlias);
  if (!td || td.parents.length === 0) return null;
  return dfs(startAlias, [startAlias]);
}

/** Extract enum entries from a typeExpr like "enum[a,b,c]" or "enum[a:admin,e:editor]".
 * Returns Array<{alias, value}>, where alias===value for plain entries.
 * Returns null if typeExpr is not an enum.
 */
function enumEntries(typeExpr) {
  if (!typeExpr) return null;
  const m = typeExpr.match(/^enum(?:<[^>]+>)?\[([^\]]*)\]/);
  if (!m) return null;
  return m[1].split(',').map(s => {
    s = s.trim();
    if (!s) return null;
    const colon = s.indexOf(':');
    if (colon >= 0) return { alias: s.slice(0, colon), value: s.slice(colon + 1) };
    return { alias: s, value: s };
  }).filter(Boolean);
}

/** Compute diagnostics for a parsed document. Returns LSP Diagnostic[]. */
function computeDiagnostics(pd) {
  const { lines, sepLine, schema, records, recIndex } = pd;
  const diags = [];

  // ── Schema-level ──────────────────────────────────────────────────────────
  const reportedCycles = new Set();
  for (const [alias, td] of schema) {
    // Only emit schema-level diagnostics for types defined in THIS document.
    // External types have wrong line numbers relative to this file.
    if (td.sourceFile !== null && td.sourceFile !== undefined) continue;

    const defLine = td.defLine;
    const lineText = lines[defLine] || '';

    // E202: Undefined parent type
    for (const parent of td.parents) {
      if (!schema.has(parent)) {
        const col = Math.max(lineText.indexOf(parent), 0);
        diags.push(makeDiag(defLine, col, parent.length,
          `E202: Undefined parent type '${parent}'`, DiagnosticSeverity.Error));
      }
    }

    // E203: Circular inheritance (report each cycle only once)
    const cycle = findInheritanceCycle(alias, schema);
    if (cycle) {
      const key = [...cycle].slice(0, -1).sort().join(',');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        diags.push(makeDiag(defLine, 0, lineText.length || 1,
          `E203: Circular inheritance: ${cycle.join(' \u2192 ')}`, DiagnosticSeverity.Error));
      }
    }
  }

  // ── Data section ──────────────────────────────────────────────────────────
  if (sepLine === -1) return diags;

  // E602: Comments are not allowed in the data section
  for (let i = sepLine + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#')) {
      diags.push(makeDiag(i, 0, lines[i].length,
        'E602: Comments are not allowed in the data section', DiagnosticSeverity.Error));
    }
  }

  const seenIds = new Map(); // alias → Set<idValue>

  for (const record of records) {
    const { alias, lineIdx, idValue, fieldValues } = record;
    const lineText = lines[lineIdx] || '';

    // E201: Unknown alias
    const typeDef = schema.get(alias);
    if (!typeDef) {
      diags.push(makeDiag(lineIdx, 0, alias.length,
        `E201: Unknown type alias '${alias}'`, DiagnosticSeverity.Error));
      continue;
    }

    // E205: Duplicate identifier
    if (idValue !== null) {
      if (!seenIds.has(alias)) seenIds.set(alias, new Set());
      const seen = seenIds.get(alias);
      if (seen.has(idValue)) {
        const idFieldIdx = typeDef.fields.findIndex(f => f.isId);
        const idFv       = idFieldIdx >= 0 ? fieldValues[idFieldIdx] : null;
        diags.push(makeDiag(lineIdx, idFv ? idFv.charStart : 0, idFv ? idFv.value.length : alias.length,
          `E205: Duplicate identifier '${idValue}' for type '${alias}'`, DiagnosticSeverity.Error));
      } else {
        seen.add(idValue);
      }
    }

    // E401: Wrong field count
    const expected = typeDef.fields.length;
    const actual   = fieldValues.length;
    if (actual > expected) {
      diags.push(makeDiag(lineIdx, 0, lineText.length,
        `E401: Too many fields for '${alias}': expected ${expected}, got ${actual}`,
        DiagnosticSeverity.Error));
    } else if (actual < expected) {
      diags.push(makeDiag(lineIdx, 0, lineText.length,
        `E401: Too few fields for '${alias}': expected ${expected}, got ${actual}`,
        DiagnosticSeverity.Warning));
    }

    // Per-field diagnostics
    const fieldCount = Math.min(fieldValues.length, typeDef.fields.length);
    for (let i = 0; i < fieldCount; i++) {
      const fv    = fieldValues[i];
      const field = typeDef.fields[i];
      if (fv.crossLine) continue;

      const { value } = fv;
      const te       = field.typeExpr;
      const baseType = te ? te.replace(/\[\]$/, '').split('@')[0] : null;

      // E403: Required field is null/empty
      if (field.required && !field.hasDefault && (value === '' || value === '~')) {
        diags.push(makeDiag(fv.lineIdx, fv.charStart, Math.max(value.length, 1),
          `E403: Required field '${field.name}' must not be null`, DiagnosticSeverity.Error));
        continue;
      }

      // Skip further checks for null/empty values and complex values
      if (!value || value === '~') continue;
      if (value[0] === '"' || value[0] === '(' || value[0] === '[' || value[0] === '{') continue;

      // E303: Invalid enum value — accept alias or full value
      const entries = enumEntries(baseType);
      if (entries) {
        const valid = entries.some(e => e.alias === value || e.value === value);
        if (!valid) {
          const labels = entries.map(e => e.alias === e.value ? e.alias : `${e.alias}(→${e.value})`).join(', ');
          diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
            `E303: '${value}' is not a valid value for '${field.name}'. Expected: ${labels}`,
            DiagnosticSeverity.Error));
          continue;
        }
      }

      // E402: Type mismatch
      if (baseType === 'int' && !/^-?\d+$/.test(value)) {
        diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
          `E402: Field '${field.name}' expects int, got '${value}'`, DiagnosticSeverity.Warning));
      } else if (baseType === 'float' && !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
        diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
          `E402: Field '${field.name}' expects float, got '${value}'`, DiagnosticSeverity.Warning));
      } else if (baseType === 'decimal' && !/^-?\d+(\.\d+)?$/.test(value)) {
        diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
          `E402: Field '${field.name}' expects decimal, got '${value}'`, DiagnosticSeverity.Warning));
      } else if (baseType === 'bool' && !/^(true|false|1|0)$/.test(value)) {
        diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
          `E402: Field '${field.name}' expects bool, got '${value}'`, DiagnosticSeverity.Error));
      }

      // E204: Unresolved object reference (warning — forward refs are allowed)
      if (baseType && /^[A-Z]/.test(baseType)) {
        const refMap = recIndex.get(baseType);
        if (!refMap || !refMap.get(value)) {
          diags.push(makeDiag(fv.lineIdx, fv.charStart, value.length,
            `E204: No '${baseType}' record with id '${value}'`, DiagnosticSeverity.Warning));
        }
      }
    }
  }

  return diags;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function computeCompletion(pd, doc, position) {
  const { lines, sepLine, schema, recIndex } = pd;
  const lineText = lines[position.line] || '';
  const prefix   = lineText.slice(0, position.character);

  // ── @schema: directive → .mxs file path completion ───────────────────────
  const schemaDirectiveMatch = prefix.match(/^@schema:(.*)$/);
  if (schemaDirectiveMatch) {
    return completeSchemaPaths(schemaDirectiveMatch[1], doc.uri);
  }

  // ── Data section only ────────────────────────────────────────────────────
  if (sepLine === -1 || position.line <= sepLine) return [];

  // Alias completion: line so far is only uppercase letters (before the '(')
  const aliasOnlyMatch = prefix.match(/^([A-Z][A-Za-z0-9_-]*)$/);
  if (aliasOnlyMatch) {
    const typed = aliasOnlyMatch[1];
    return [...schema.keys()]
      .filter(a => a.startsWith(typed))
      .map(alias => {
        const td = schema.get(alias);
        return {
          label: alias,
          kind: CompletionItemKind.Class,
          detail: `${alias}(${td.fields.map(f => f.name).join(' | ')})`,
        };
      });
  }

  // Field value completion: cursor is inside record parentheses
  const ctx = findRecordContext(lines, sepLine, position);
  if (!ctx) return [];

  const { alias, fieldIndex } = ctx;
  const td = schema.get(alias);
  if (!td || fieldIndex >= td.fields.length) return [];

  return fieldValueCompletions(td.fields[fieldIndex], recIndex);
}

/**
 * Walk backward from position to find the enclosing data record.
 * Returns { alias, fieldIndex } or null.
 */
function findRecordContext(lines, sepLine, position) {
  // Find the line where the record starts (alias + opening paren)
  let startLine = position.line;
  while (startLine > sepLine) {
    if (/^[A-Z][A-Za-z0-9_-]*\s*\(/.test(lines[startLine])) break;
    startLine--;
  }
  if (startLine <= sepLine) return null;

  const aliasMatch = lines[startLine].match(/^([A-Z][A-Za-z0-9_-]*)/);
  if (!aliasMatch) return null;
  const alias = aliasMatch[1];

  const openParenIdx = lines[startLine].indexOf('(');
  if (openParenIdx === -1) return null;

  // Collect text from just after the opening '(' up to the cursor
  let text = '';
  if (startLine === position.line) {
    text = lines[startLine].slice(openParenIdx + 1, position.character);
  } else {
    text = lines[startLine].slice(openParenIdx + 1);
    for (let i = startLine + 1; i < position.line; i++) {
      text += lines[i];
    }
    text += lines[position.line].slice(0, position.character);
  }

  // Count depth-0 '|' separators to get field index
  let depth = 0, fieldIndex = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '|' && depth === 0) fieldIndex++;
  }

  return { alias, fieldIndex };
}

/**
 * Build completion items for a single field based on its type expression.
 */
function fieldValueCompletions(field, recIndex) {
  const te = field.typeExpr;
  if (!te) return [];

  const baseExpr             = te.replace(/\[\]$/, '');  // strip array suffix
  const [base, annotation]   = baseExpr.split('@');

  // enum[alias:value,...] → one item per alias
  const entries = enumEntries(base);
  if (entries) {
    return entries.map(({ alias, value }) => ({
      label: alias,
      kind: CompletionItemKind.EnumMember,
      detail: alias === value ? `enum value for '${field.name}'` : `${value} (${field.name})`,
    }));
  }

  // bool → four canonical forms
  if (base === 'bool') {
    return ['1', '0', 'true', 'false'].map(v => ({
      label: v,
      kind: CompletionItemKind.Value,
      detail: `bool value for '${field.name}'`,
    }));
  }

  // str@date → today's date as ISO 8601
  if (base === 'str' && annotation === 'date') {
    const today = new Date().toISOString().slice(0, 10);
    return [{ label: today, kind: CompletionItemKind.Value, detail: 'ISO 8601 date (YYYY-MM-DD)', insertText: today }];
  }

  // str@datetime / str@timestamp → current datetime as ISO 8601
  if (base === 'str' && (annotation === 'datetime' || annotation === 'timestamp')) {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    return [{ label: now, kind: CompletionItemKind.Value, detail: 'ISO 8601 datetime', insertText: now }];
  }

  // Object type reference (e.g. U, AD) → IDs of known records of that type
  if (/^[A-Z]/.test(base)) {
    const refMap = recIndex.get(base);
    if (!refMap) return [];
    return [...refMap.entries()].map(([id, entry]) => ({
      label: id,
      kind: CompletionItemKind.Reference,
      detail: `${base} record (id ${id})`,
    }));
  }

  return [];
}

/**
 * Complete .mxs file names for @schema: directives.
 */
function completeSchemaPaths(typed, docUri) {
  try {
    const docDir  = path.dirname(uriToFsPath(docUri));
    const entries = fs.readdirSync(docDir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.mxs') && e.name.startsWith(typed))
      .map(e => ({
        label: e.name,
        kind: CompletionItemKind.File,
        detail: '.mxs schema file',
        insertText: e.name,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * Find all usages of the alias under the cursor.
 * - In the schema section: returns the definition line + all data record lines that use this alias.
 * - In the data section on an alias: same as above.
 * If includeDeclaration is false, the definition line is omitted.
 */
function computeReferences(pd, docUri, pos, context) {
  const { lines, sepLine, schema, records } = pd;
  const line = lines[pos.line] || '';
  const col  = pos.character;

  // Resolve the alias the cursor is on
  let alias = null;

  // Schema section or data-section alias at line start
  const aliasLineMatch = line.match(/^([A-Z][A-Za-z0-9_-]*)/);
  if (aliasLineMatch && col <= aliasLineMatch[1].length) {
    alias = aliasLineMatch[1];
    // In schema section, alias may be ALIAS:TypeName — key is the alias part
    if (!schema.has(alias)) alias = null;
  }

  // Fall back: find any known alias token under cursor
  if (!alias) {
    for (const a of schema.keys()) {
      let idx = 0;
      while ((idx = line.indexOf(a, idx)) !== -1) {
        const end    = idx + a.length;
        const before = idx === 0 ? '' : line[idx - 1];
        const after  = end < line.length ? line[end] : '';
        if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
          if (col >= idx && col <= end) { alias = a; break; }
        }
        idx = end;
      }
      if (alias) break;
    }
  }

  if (!alias) return [];

  const td = schema.get(alias);
  const locations = [];

  // Declaration
  if (context.includeDeclaration && td) {
    const uri = td.sourceFile ? fsPathToUri(td.sourceFile) : docUri;
    locations.push({
      uri,
      range: { start: { line: td.defLine, character: 0 },
               end:   { line: td.defLine, character: lines[td.defLine] ? lines[td.defLine].length : 0 } },
    });
  }

  // All data records that use this alias
  for (const record of records) {
    if (record.alias !== alias) continue;
    const recLine = lines[record.lineIdx] || '';
    const aliasLen = alias.length;
    locations.push({
      uri: docUri,
      range: { start: { line: record.lineIdx, character: 0 },
               end:   { line: record.lineIdx, character: aliasLen } },
    });
  }

  return locations;
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/**
 * Rename an alias across the entire document:
 * - The type definition line (ALIAS:TypeName or ALIAS<...>( )
 * - Every data record line that starts with the alias
 * Returns an LSP WorkspaceEdit or null.
 */
function computeRename(pd, doc, pos, newName) {
  const { lines, schema, records } = pd;
  const line = lines[pos.line] || '';
  const col  = pos.character;

  // Validate new name
  if (!/^[A-Z][A-Za-z0-9_-]*$/.test(newName)) return null;

  // Resolve the alias under the cursor (same logic as references)
  let alias = null;
  const aliasLineMatch = line.match(/^([A-Z][A-Za-z0-9_-]*)/);
  if (aliasLineMatch && col <= aliasLineMatch[1].length) {
    alias = aliasLineMatch[1];
    if (!schema.has(alias)) alias = null;
  }
  if (!alias) {
    for (const a of schema.keys()) {
      let idx = 0;
      while ((idx = line.indexOf(a, idx)) !== -1) {
        const end    = idx + a.length;
        const before = idx === 0 ? '' : line[idx - 1];
        const after  = end < line.length ? line[end] : '';
        if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) {
          if (col >= idx && col <= end) { alias = a; break; }
        }
        idx = end;
      }
      if (alias) break;
    }
  }
  if (!alias) return null;

  const td = schema.get(alias);
  const edits = [];
  const uri   = doc.uri;

  // Replace alias on the type definition line
  if (td && (td.sourceFile === null || td.sourceFile === undefined)) {
    const defText = lines[td.defLine] || '';
    // The alias is always at the start of the def line
    if (defText.startsWith(alias)) {
      edits.push({
        range: { start: { line: td.defLine, character: 0 },
                 end:   { line: td.defLine, character: alias.length } },
        newText: newName,
      });
    }
  }

  // Replace alias at the start of every data record line
  for (const record of records) {
    if (record.alias !== alias) continue;
    edits.push({
      range: { start: { line: record.lineIdx, character: 0 },
               end:   { line: record.lineIdx, character: alias.length } },
      newText: newName,
    });
  }

  if (edits.length === 0) return null;
  return { changes: { [uri]: edits } };
}
