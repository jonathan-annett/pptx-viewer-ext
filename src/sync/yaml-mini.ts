// Minimal YAML subset parser, sized for the .sync.yaml schema only.
//
// What's supported:
//   - Top-level mapping (block style only)
//   - Nested mappings via indentation
//   - Sequences of strings:           - "*.tmp"
//   - Sequences of mappings:          - name: foo
//                                       path: bar
//   - Comments starting with `#` (after whitespace)
//   - Single- and double-quoted strings (with the usual `\n \t \\ \"` escapes
//     in double quotes, and `''` for a literal `'` inside single quotes)
//   - Unquoted scalars (everything from after `: ` to end-of-line, trimmed)
//
// What's NOT supported (anything outside the .sync.yaml schema):
//   - Flow style:           `[a, b]` or `{x: 1, y: 2}`
//   - Multi-line strings:   `|` and `>`
//   - Anchors / aliases:    `&foo` `*foo`
//   - Tags:                 `!!str`
//   - Boolean / null / numeric literal coercion — all scalars are strings
//   - Tabs in indentation   (rejected with a clear error)
//
// Why a custom parser instead of a yaml lib: the full `yaml` package adds
// ~207 KB to the web-extension bundle. The schema we accept is tiny enough
// that a tolerant subset parser earns its keep on bundle size.
//
// Errors are thrown as Error with `line N:` prefixed messages.

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  /** Content with leading whitespace and trailing comment+whitespace stripped. */
  text: string;
  /** Count of leading spaces (tabs are rejected at tokenise time). */
  indent: number;
  /** 1-based line number in the original source, for error messages. */
  lineNum: number;
}

/**
 * Parse a YAML subset document. Returns the parsed value, or `null` for an
 * empty/whitespace-only document. Throws on syntax errors with a line-prefixed
 * message.
 */
export function parseYamlMini(source: string): YamlValue | null {
  const lines = tokenise(source);
  if (lines.length === 0) return null;
  if (lines[0].indent !== 0) {
    throw new Error(`line ${lines[0].lineNum}: top-level content must start at column 0`);
  }
  const { value, next } = parseValue(lines, 0, 0);
  if (next < lines.length) {
    throw new Error(
      `line ${lines[next].lineNum}: unexpected content after top-level value`,
    );
  }
  return value;
}

// ───── tokeniser ─────────────────────────────────────────────────────────

function tokenise(source: string): Line[] {
  const out: Line[] = [];
  let lineNum = 0;
  for (const raw of source.split(/\r?\n/)) {
    lineNum++;
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;
    let indent = 0;
    while (indent < stripped.length && stripped[indent] === ' ') indent++;
    if (indent < stripped.length && stripped[indent] === '\t') {
      throw new Error(`line ${lineNum}: tabs are not supported in indentation; use spaces`);
    }
    out.push({
      text: stripped.slice(indent).trimEnd(),
      indent,
      lineNum,
    });
  }
  return out;
}

/**
 * Strip a `#` comment from a line, respecting single- and double-quoted
 * strings. A `#` only starts a comment when it's at column 0 or preceded
 * by whitespace — `value#hash` is not a comment.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let prev = ' '; // start-of-line counts as whitespace
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && /\s/.test(prev)) {
      return line.slice(0, i);
    }
    prev = ch;
  }
  return line;
}

// ───── parser ────────────────────────────────────────────────────────────

interface Parsed {
  value: YamlValue;
  next: number;
}

function parseValue(lines: Line[], i: number, indent: number): Parsed {
  const line = lines[i];
  if (line.text.startsWith('- ') || line.text === '-') {
    return parseSequence(lines, i, indent);
  }
  if (findKeyColon(line.text) >= 0) {
    return parseMapping(lines, i, indent);
  }
  return { value: parseScalar(line.text, line.lineNum), next: i + 1 };
}

function parseSequence(lines: Line[], i: number, indent: number): Parsed {
  const items: YamlValue[] = [];
  while (
    i < lines.length &&
    lines[i].indent === indent &&
    (lines[i].text === '-' || lines[i].text.startsWith('- '))
  ) {
    const line = lines[i];
    const rest = line.text === '-' ? '' : line.text.slice(2);

    if (rest === '') {
      // Item value lives on subsequent lines at a deeper indent.
      i++;
      if (i >= lines.length || lines[i].indent <= indent) {
        items.push('');
        continue;
      }
      const r = parseValue(lines, i, lines[i].indent);
      items.push(r.value);
      i = r.next;
      continue;
    }

    // `- ` is two columns wide. The item's content sits at indent+2.
    // Substitute a virtual line and recurse — caller has already advanced i
    // past this slot before the next iteration's loop guard runs.
    const virtual: Line = {
      text: rest,
      indent: indent + 2,
      lineNum: line.lineNum,
    };
    lines[i] = virtual;
    const r = parseValue(lines, i, indent + 2);
    items.push(r.value);
    i = r.next;
  }
  return { value: items, next: i };
}

function parseMapping(lines: Line[], i: number, indent: number): Parsed {
  const map: { [k: string]: YamlValue } = {};
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    const colonIdx = findKeyColon(line.text);
    if (colonIdx < 0) break; // not a mapping line; let caller decide
    const keyText = line.text.slice(0, colonIdx).trim();
    if (keyText === '') {
      throw new Error(`line ${line.lineNum}: missing mapping key before ':'`);
    }
    const key = parseScalar(keyText, line.lineNum);
    if (typeof key !== 'string') {
      throw new Error(`line ${line.lineNum}: mapping key must be a string`);
    }
    const valueText = line.text.slice(colonIdx + 1).trim();

    if (valueText !== '') {
      map[key] = parseScalar(valueText, line.lineNum);
      i++;
      continue;
    }

    // Value is on subsequent lines at a deeper indent.
    i++;
    if (i >= lines.length || lines[i].indent <= indent) {
      map[key] = '';
      continue;
    }
    const r = parseValue(lines, i, lines[i].indent);
    map[key] = r.value;
    i = r.next;
  }
  return { value: map, next: i };
}

/**
 * Find the first `:` that terminates a mapping key — i.e. one that's not
 * inside quotes and is followed by whitespace or end-of-line. Returns -1 if
 * the line is not a mapping line.
 */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      if (i === text.length - 1 || text[i + 1] === ' ') return i;
    }
  }
  return -1;
}

function parseScalar(text: string, lineNum: number): string {
  const t = text.trim();
  if (t.length >= 2) {
    if (t.startsWith('"') && t.endsWith('"')) {
      return unescapeDouble(t.slice(1, -1), lineNum);
    }
    if (t.startsWith("'") && t.endsWith("'")) {
      // Single-quoted: only `''` is meaningful (literal single quote).
      return t.slice(1, -1).replace(/''/g, "'");
    }
  }
  return t;
}

function unescapeDouble(s: string, lineNum: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    if (i >= s.length) throw new Error(`line ${lineNum}: trailing backslash in string`);
    const esc = s[i];
    switch (esc) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case '/': out += '/'; break;
      case '0': out += '\0'; break;
      default: out += esc; break; // tolerant: pass unknown escape through
    }
  }
  return out;
}
