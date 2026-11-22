import crypto from "crypto";
import * as babelParser from "@babel/parser";

export const ANALYZER_VERSION = "3.0.1";

const MAX_CACHE_ENTRIES = 500;
const MAX_STATIC_CACHE_ENTRIES = 1000;
const MAX_CODE_LENGTH = 200_000;
const cache = new Map(); // LRU: key -> { ir, ctx, time?, space? }
const staticAnalysisCache = new Map(); // hashKey -> cached static analysis result

/**
 * Computes deterministic SHA-256 hash for complexity cache key.
 * hash(normalizedCode + language + analyzerVersion)
 */
export function computeComplexityHash(code, language, version = ANALYZER_VERSION) {
  const normalizedCode = (code || "").replace(/\r\n?/g, "\n").trim();
  const normalizedLang = String(language || "").toLowerCase().trim();
  return crypto
    .createHash("sha256")
    .update(`${normalizedCode}::${normalizedLang}::${version}`)
    .digest("hex");
}

export function clearComplexityCache() {
  cache.clear();
  staticAnalysisCache.clear();
}

export function getComplexityCacheSize() {
  return staticAnalysisCache.size;
}

const PY = "py";
const JS = "js";
const BRACE = "brace";
const HIGH = 2;
const MED = 1;
const LOW = 0;
const CONF = ["low", "medium", "high"];

/* ───────────────────────── text utilities ───────────────────────── */

const C_STRIP =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;
const PY_STRIP =
  /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
const blankOut = (m) => m.replace(/[^\n]/g, " ");

/** Length-preserving removal of comments/strings (offsets stay valid). */
const stripSource = (code, fam) =>
  code.replace(fam === PY ? PY_STRIP : C_STRIP, blankOut);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWs = (c) => c === " " || c === "\n" || c === "\t" || c === "\r";
const skipWs = (s, i) => {
  while (i < s.length && isWs(s[i])) i++;
  return i;
};
const words = (s) => (s ? s.match(/[A-Za-z_$][\w$]*/g) || [] : []);
const lastIdent = (s) => {
  const m = /([A-Za-z_$][\w$]*)[\s\])]*$/.exec(s || "");
  return m ? m[1] : null;
};

function matchForward(s, open, o = "(", c = ")") {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === o) d++;
    else if (ch === c && --d === 0) return i;
  }
  return -1;
}

function splitTop(text, sep = ",", angle = false) {
  const out = [];
  let d = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{" || (angle && ch === "<")) d++;
    else if (ch === ")" || ch === "]" || ch === "}" || (angle && ch === ">")) d--;
    else if (ch === sep && d === 0) {
      out.push(text.slice(last, i).trim());
      last = i + 1;
    }
  }
  const tail = text.slice(last).trim();
  if (tail || out.length) out.push(tail);
  return out;
}

function stmtEnd(s, from, close) {
  let d = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") d++;
    else if (ch === ")") d--;
    else if (d === 0) {
      if (ch === ";") return i + 1;
      if (ch === "{") return close[i] >= 0 ? close[i] + 1 : s.length;
    }
  }
  return s.length;
}

function paramNames(text, fam) {
  return splitTop(text, ",", true)
    .map((p, i) => {
      let q = p.replace(/=[\s\S]*$/, "");
      if (fam !== BRACE) q = q.replace(/:[\s\S]*$/, "");
      q = q.replace(/\[\s*\]/g, " ").trim();
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(q);
      return m ? m[1] : `$${i}`;
    })
    .filter((n) => n !== "self" && n !== "cls" && n !== "this");
}

/* ───────────────────────── regex catalogue ───────────────────────── */

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "try", "return", "sizeof",
  "synchronized", "new", "delete", "throw", "case", "function", "typeof", "await",
  "foreach", "elif", "with", "using", "lock",
]);

const FN_HDR =
  /([A-Za-z_~]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:(?:const|noexcept|override|final|mutable|volatile)\s+)*(?:throws\s+[\w.,\s]+?)?(?:->\s*[\w:<>*&,\s]+?)?\s*$/;
const LAMBDA_HDR =
  /(?:([A-Za-z_]\w*)\s*(?::\s*[\w:<>,\s*&]+?)?\s*=\s*)?\[[^\][]*\]\s*(?:\(([^()]*)\))?\s*(?:mutable\s*)?(?:->\s*[\w:<>*&,\s]+?)?\s*$/;

const MEMO_RE =
  /\b(?:memo|memoize|memoization|cache|cached|dp|mem|lru_cache|dpTable)\b|@(?:functools\.)?(?:lru_)?cache/;
const GRAPH_RE =
  /\b(?:visited|seen|vis|marked|indegree|indeg|in_degree|dist|dists)\b/;
const GRID_RE = /\b(?:dirs?|directions?|DIRS|moves|deltas?|dx|dy|dr|dc|di|dj|drow|dcol)\b/;
const HALVE_RE =
  /\bmid\b|\bmiddle\b|\bhalf\b|\/\/?\s*(?:[2-9]|\d{2,})\b|>>>?\s*\d|\*\s*0\.5\b/;
const TREE_RE =
  /(?:\?\.|\.|->)\s*(?:left|right|next|nxt|children|child|kids|neighbou?rs?|lc|rc|parent)\b|\b(?:child|children|kid|neighbou?rs?|nei|nb|adj|adjacent|nxt|next)\b/i;
const STEP_RE = /[A-Za-z_$][\w$\][]*\s*[-+]\s*\d+|\+\+|--/;
const COPY_RE =
  /\.slice\s*\(|\.concat\s*\(|\.substring\s*\(|\.substr\s*\(|\bcopyOf(?:Range)?\s*\(|\bsubstr\s*\(|\[[^\][]*:[^\][]*\]/;
const PERM_RE = /\b(?:used|visited|vis|taken|chosen|swap|permut\w*|next_permutation)\b/;
const SORT_RE = /\b(?:sort|sorted|stable_sort|qsort|nlargest|nsmallest)\s*\(/g;
const DIR_NAMES = /^(?:dirs?|directions?|deltas?|moves|dx|dy|DIRS|DIRECTIONS)$/;
const DEFAULT_QUEUES = [
  "q", "que", "queue", "stack", "stk", "dq", "pq", "heap", "frontier", "todo",
];

const ITER_METHODS = new Set([
  "forEach", "map", "filter", "reduce", "reduceRight", "some", "every", "find",
  "findIndex", "findLast", "findLastIndex", "flatMap",
]);
const FN_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ClassMethod", "ObjectMethod", "ClassPrivateMethod",
]);
const SKIP_KEYS = new Set([
  "loc", "extra", "comments", "leadingComments", "trailingComments",
  "innerComments", "range", "errors", "tokens", "start", "end", "type",
]);

/* ───────────────────── complexity algebra ───────────────────── */

const LETTERS = ["n", "m", "k", "p", "q", "r"];
const mk = (lin = 0, log = 0, extra = {}) => ({
  lin, log, sq: 0, dims: null, special: null, ...extra,
});
const ZERO_CX = mk();
const EMPTY_CHAIN = { lin: 0, log: 0, sq: 0, keys: [], logOp: false, special: null };

const rank = (c) =>
  c.rank !== undefined ? c.rank : c.lin * 10 + c.log + (c.sq || 0) * 5;

function label(c) {
  if (c.label) return c.label;
  if (c.special === "max") return "O(max(n, m))";
  if (c.special === "sum") return "O(n + m)";
  const parts = [];
  if (c.lin > 0) {
    if (c.dims && c.dims.length > 1) {
      parts.push(
        c.dims
          .map((d, i) => {
            const l = LETTERS[i] || `x${i}`;
            return d > 1 ? `${l}^${d}` : l;
          })
          .join(" × "),
      );
    } else parts.push(c.lin === 1 ? "n" : `n^${c.lin}`);
  }
  if (c.sq) parts.push(c.sq === 1 ? "√n" : `n^${c.sq / 2}`);
  if (c.log === 1) parts.push("log n");
  else if (c.log > 1) parts.push(`log^${c.log} n`);
  return parts.length ? `O(${parts.join(" ")})` : "O(1)";
}

const CLASS_BY_LABEL = {
  "O(1)": "CONSTANT", "O(log n)": "LOGARITHMIC", "O(n)": "LINEAR",
  "O(n + m)": "LINEAR_MULTI", "O(max(n, m))": "LINEAR_MAX",
  "O(n log n)": "LOG_LINEAR", "O(n^2)": "QUADRATIC", "O(n × m)": "QUADRATIC_MULTI",
  "O(n^3)": "CUBIC", "O(2^n)": "EXPONENTIAL", "O(n!)": "FACTORIAL",
  "O(V + E)": "LINEAR_GRAPH",
};
const classOf = (l) =>
  CLASS_BY_LABEL[l] || (/\^n\)$/.test(l) ? "EXPONENTIAL" : "POLYNOMIAL");

function sumCx(a, b) {
  if (a.label || b.label || a.special || b.special || a.rank !== undefined || b.rank !== undefined)
    return null;
  return mk(a.lin + b.lin, a.log + b.log, {
    sq: (a.sq || 0) + (b.sq || 0),
    dims: a.dims && b.dims ? [...a.dims, ...b.dims] : null,
  });
}

/* ───────────────────────── IR construction ───────────────────────── */

const makeFn = (name, params, hdrStart, bodyStart, end) => ({
  name, params, hdrStart, bodyStart, end,
  loops: [], selfCalls: [], sorts: [], deco: "", chains: null, cx: null, rec: null,
});
const makeLoop = (kind, start, bodyStart, end, header, fn, parent) => ({
  kind, start, bodyStart, end, header, fn, parent,
  depth: parent ? parent.depth + 1 : 1,
  var: null, init: null, test: null, update: null, iter: null,
  key: null, weight: "lin", logOp: false, parallel: null, skip: false,
});

function fnAt(fns, root, pos) {
  let best = root;
  for (const f of fns) {
    if (f !== root && pos >= f.bodyStart && pos < f.end && (best === root || f.bodyStart > best.bodyStart))
      best = f;
  }
  return best;
}

/** JS/TS through Babel — single traversal. */
function buildAstIR(src, text, ts) {
  const ast = babelParser.parse(src, {
    sourceType: "unambiguous",
    plugins: ts ? ["typescript"] : [],
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
  });
  const root = makeFn("<global>", [], 0, 0, text.length);
  const fns = [root];
  const loops = [];
  const hints = new Map();
  const inline = new Set();
  let fn = root;
  let loop = null;

  const isFn = (n) => n && FN_TYPES.has(n.type);
  const keyName = (k) => (k ? k.name ?? (typeof k.value === "string" ? k.value : null) : null);
  const astParam = (p, i) =>
    p.type === "Identifier" ? p.name
      : p.type === "AssignmentPattern" ? astParam(p.left, i)
      : p.type === "RestElement" ? astParam(p.argument, i)
      : p.type === "TSParameterProperty" ? astParam(p.parameter, i)
      : `$${i}`;

  const pushLoop = (kind, node, bodyStart, header) => {
    const L = makeLoop(kind, node.start, bodyStart, node.end, header, fn, loop);
    fn.loops.push(L);
    loops.push(L);
    return L;
  };

  function kids(node) {
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i].type === "string") visit(v[i]);
      } else if (typeof v.type === "string") visit(v);
    }
  }

  function visit(node) {
    const t = node.type;
    if (FN_TYPES.has(t)) {
      if (inline.has(node)) return kids(node);
      const name = node.id?.name || keyName(node.key) || hints.get(node) || "<anonymous>";
      const f = makeFn(name, node.params.map(astParam), node.start, node.body.start, node.end);
      fns.push(f);
      const pf = fn, pl = loop;
      fn = f; loop = null;
      kids(node);
      fn = pf; loop = pl;
      return;
    }
    switch (t) {
      case "VariableDeclarator":
        if (node.id?.type === "Identifier" && isFn(node.init)) hints.set(node.init, node.id.name);
        break;
      case "AssignmentExpression":
        if (isFn(node.right))
          hints.set(node.right, node.left.name || node.left.property?.name || "<anonymous>");
        break;
      case "ClassProperty":
      case "ObjectProperty":
        if (isFn(node.value)) hints.set(node.value, keyName(node.key) || "<anonymous>");
        break;
      case "ForStatement":
      case "WhileStatement":
      case "ForOfStatement":
      case "ForInStatement":
      case "DoWhileStatement": {
        let inner;
        if (t === "DoWhileStatement") inner = text.slice(node.test.start, node.test.end);
        else {
          const o = text.indexOf("(", node.start);
          const c = matchForward(text, o);
          inner = c > o ? text.slice(o + 1, c) : "";
        }
        const L = pushLoop(t === "WhileStatement" ? "while" : t === "DoWhileStatement" ? "do" : "for", node, node.body.start, inner);
        const pl = loop;
        loop = L;
        kids(node);
        loop = pl;
        return;
      }
      case "CallExpression": {
        const c = node.callee;
        let name = null;
        let thisCall = false;
        if (c.type === "Identifier") name = c.name;
        else if (c.type === "MemberExpression" && !c.computed && c.property?.name) {
          name = c.property.name;
          thisCall = c.object.type === "ThisExpression";
        }
        if (name === "sort" || name === "toSorted") fn.sorts.push(node.start);
        if (fn !== root && name === fn.name && (c.type === "Identifier" || thisCall))
          fn.selfCalls.push({
            pos: node.start,
            args: node.arguments.map((a) => text.slice(a.start, a.end).trim()),
          });
        if (c.type === "MemberExpression" && node.arguments.length) {
          const isFrom = name === "from" && c.object.name === "Array" && isFn(node.arguments[1]);
          const cb = isFrom ? node.arguments[1] : ITER_METHODS.has(name) && isFn(node.arguments[0]) ? node.arguments[0] : null;
          if (cb) {
            inline.add(cb);
            const L = pushLoop("iter", node, cb.start, "");
            L.iter = isFrom
              ? (/length\s*:\s*([^,}]+)/.exec(text.slice(node.arguments[0].start, node.arguments[0].end)) || [])[1] || ""
              : text.slice(c.object.start, c.object.end);
            L.var = cb.params?.[0] ? astParam(cb.params[0], 0) : null;
            visit(c.object);
            const pl = loop;
            loop = L;
            for (const a of node.arguments) visit(a);
            loop = pl;
            return;
          }
        }
        break;
      }
      default:
    }
    kids(node);
  }

  visit(ast.program || ast);
  return { fns, root, loops, parseErrors: ast.errors ? ast.errors.length : 0 };
}

/** C / C++ / Java / C# (and JS fallback): brace scanner on cleaned source. */
function buildBraceIR(text) {
  const n = text.length;
  const close = new Int32Array(n).fill(-1);
  const st = [];
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 123) st.push(i);
    else if (c === 125 && st.length) close[st.pop()] = i;
  }
  const root = makeFn("<global>", [], 0, 0, n);
  const fns = [root];
  const re = /\{/g;
  let m;
  while ((m = re.exec(text))) {
    const i = m.index;
    const end = close[i];
    if (end < 0) continue;
    const pre = text.slice(Math.max(0, i - 300), i);
    const h = FN_HDR.exec(pre);
    if (h) {
      if (KEYWORDS.has(h[1])) continue;
      fns.push(makeFn(h[1], paramNames(h[2], BRACE), i - h[0].length, i + 1, end));
      continue;
    }
    const l = LAMBDA_HDR.exec(pre);
    if (l) fns.push(makeFn(l[1] || "<lambda>", paramNames(l[2] || "", BRACE), i - l[0].length, i + 1, end));
  }

  const loops = [];
  const kw = /\b(for|while|do|foreach)\b/g;
  const add = (kind, at, bodyStart, endPos, header) => {
    const L = makeLoop(kind, at, bodyStart, endPos, header, fnAt(fns, root, at), null);
    loops.push(L);
  };
  while ((m = kw.exec(text))) {
    const k = m[1];
    const at = m.index;
    if (at > 0 && (text[at - 1] === "." || text[at - 1] === ">")) continue;
    let p = skipWs(text, at + k.length);
    if (k === "do") {
      if (text[p] !== "{" || close[p] < 0) continue;
      let q = skipWs(text, close[p] + 1);
      if (!text.startsWith("while", q)) continue;
      q = skipWs(text, q + 5);
      if (text[q] !== "(") continue;
      const r = matchForward(text, q);
      add("do", at, p + 1, r < 0 ? close[p] + 1 : r + 1, text.slice(q + 1, r < 0 ? q + 1 : r));
      continue;
    }
    if (text[p] !== "(") continue;
    const r = matchForward(text, p);
    if (r < 0) continue;
    const inner = text.slice(p + 1, r);
    const q = skipWs(text, r + 1);
    const kind = k === "while" ? "while" : "for";
    if (k === "while" && text[q] === ";") {
      let b = at - 1;
      while (b >= 0 && isWs(text[b])) b--;
      if (text[b] === "}") continue; // do-while tail
      add(kind, at, q, q + 1, inner);
    } else if (text[q] === "{") {
      if (close[q] < 0) continue;
      add(kind, at, q + 1, close[q] + 1, inner);
    } else add(kind, at, q, stmtEnd(text, q, close), inner);
  }
  return finishScanIR(fns, root, loops, text, BRACE);
}

function buildPyIR(text) {
  const lines = [];
  const starts = [];
  let off = 0;
  for (const t of text.split("\n")) {
    const indent = (/^[ \t]*/.exec(t)[0].replace(/\t/g, "    ")).length;
    lines.push({ s: off, e: off + t.length, t, indent, blank: !/\S/.test(t) });
    starts.push(off);
    off += t.length + 1;
  }
  const lineAt = (o) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const blockEnd = (idx, indent) => {
    let last = idx;
    for (let j = idx + 1; j < lines.length; j++) {
      if (lines[j].blank) continue;
      if (lines[j].indent <= indent) break;
      last = j;
    }
    return lines[last].e;
  };
  const colonAfter = (from) => {
    let d = 0;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "[" || ch === "{") d++;
      else if (ch === ")" || ch === "]" || ch === "}") d--;
      else if (ch === ":" && d === 0 && text[i + 1] !== "=") return i;
    }
    return -1;
  };
  const bodyRange = (colon, indent) => {
    const li = lineAt(colon);
    const rest = text.slice(colon + 1, lines[li].e);
    return /\S/.test(rest) ? lines[li].e : blockEnd(li, indent);
  };

  const root = makeFn("<global>", [], 0, 0, text.length);
  const fns = [root];
  const loops = [];
  for (let i = 0; i < lines.length; i++) {
    const { t, s, indent } = lines[i];
    if (lines[i].blank) continue;
    const d = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/.exec(t);
    if (d) {
      const open = s + d[0].length - 1;
      const r = matchForward(text, open);
      if (r > 0) {
        const colon = colonAfter(r + 1);
        if (colon > 0) {
          const f = makeFn(d[1], paramNames(text.slice(open + 1, r), PY), s, colon + 1, bodyRange(colon, indent));
          let k = i - 1;
          while (k >= 0 && /^\s*@/.test(lines[k].t)) f.deco += lines[k--].t;
          fns.push(f);
        }
      }
      continue;
    }
    const lm = /^[ \t]*(?:async[ \t]+)?(for|while)\b/.exec(t);
    if (lm) {
      const kwEnd = s + lm[0].length;
      const colon = colonAfter(kwEnd);
      if (colon > 0) {
        const L = makeLoop(lm[1], s + t.search(/\S/), colon + 1, bodyRange(colon, indent), text.slice(kwEnd, colon).trim(), root, null);
        loops.push(L);
      }
    }
    // comprehension / generator loops: `for` nested inside brackets on this line
    if (t.includes("for")) {
      const stack = [];
      const fr = /[([{]|[)\]}]|\bfor\b/g;
      let m;
      while ((m = fr.exec(t))) {
        const ch = m[0];
        if (ch === "(" || ch === "[" || ch === "{") stack.push(s + m.index);
        else if (ch === ")" || ch === "]" || ch === "}") stack.pop();
        else if (stack.length) {
          const o = stack[stack.length - 1];
          const oc = text[o];
          const e = matchForward(text, o, oc, oc === "(" ? ")" : oc === "[" ? "]" : "}");
          const hdr = /^\s*(.*?)\s*(?=\bfor\b|\bif\b|\belse\b|[)\]}]|$)/.exec(t.slice(m.index + 3))[1];
          loops.push(makeLoop("comp", s + m.index, s + m.index, e < 0 ? lines[i].e : e + 1, hdr, root, null));
        }
      }
    }
  }
  return finishScanIR(fns, root, loops, text, PY);
}

function finishScanIR(fns, root, loops, text, fam) {
  loops.sort((a, b) => a.start - b.start);
  const stack = [];
  for (const L of loops) {
    L.fn = fnAt(fns, root, L.start);
    while (stack.length && stack[stack.length - 1].end <= L.start) stack.pop();
    const top = stack[stack.length - 1];
    L.parent = top && top.fn === L.fn ? top : null;
    L.depth = L.parent ? L.parent.depth + 1 : 1;
    stack.push(L);
    L.fn.loops.push(L);
  }
  // self-calls
  for (const f of fns) {
    if (f === root || f.name.startsWith("<")) continue;
    const nm = esc(f.name);
    const re = new RegExp(
      `(?<![\\w.>:$])${nm}\\s*\\(|(?:\\bthis\\s*(?:->|\\.)|\\bself\\.|\\bcls\\.|\\b\\w+::)${nm}\\s*\\(`,
      "g",
    );
    re.lastIndex = f.bodyStart;
    let m;
    while ((m = re.exec(text)) && m.index < f.end) {
      const open = m.index + m[0].length - 1;
      const r = matchForward(text, open);
      if (r < 0) continue;
      const args = splitTop(text.slice(open + 1, r));
      if (args.length > f.params.length && f.params.length) continue; // overload / wrapper
      f.selfCalls.push({ pos: m.index, args });
    }
  }
  // sort calls
  SORT_RE.lastIndex = 0;
  let sm;
  while ((sm = SORT_RE.exec(text))) {
    const before = text.slice(Math.max(0, sm.index - 6), sm.index);
    if (/def\s+$/.test(before)) continue;
    const r = matchForward(text, sm.index + sm[0].length - 1);
    if (r > 0 && text[skipWs(text, r + 1)] === "{") continue; // definition
    fnAt(fns, root, sm.index).sorts.push(sm.index);
  }
  return { fns, root, loops, parseErrors: 0 };
}

/* ───────────────────────── shared context ───────────────────────── */

function buildCtx(text, fam) {
  const alias = Object.create(null);
  const a1 =
    /\b([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*(?:int|long|size_t|auto)\s*\)\s*)?(?:len\(\s*([\w$.[\]]+)\s*\)|([\w$.[\]]+?)\s*\.\s*(?:length|size|count)\s*(?:\(\s*\))?)/g;
  let m;
  while ((m = a1.exec(text))) alias[m[1]] = m[2] || m[3];
  if (fam === PY) {
    const a2 =
      /\b([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*=\s*len\(\s*([\w.[\]]+)\s*\)\s*,\s*len\(\s*([\w.[\]]+)\s*\)/g;
    while ((m = a2.exec(text))) {
      alias[m[1]] = m[3];
      alias[m[2]] = m[4];
    }
  }

  const queueNames = new Set(DEFAULT_QUEUES);
  const heapNames = new Set();
  const qd =
    /\b(?:queue|deque|stack|priority_queue|Queue|Deque|ArrayDeque|Stack|LinkedList|PriorityQueue)\b\s*(?:<[^;=(){}]*>)?\s*(\w+)/g;
  while ((m = qd.exec(text))) queueNames.add(m[1]);
  const pyq = /\b(\w+)\s*=\s*(?:collections\.)?deque\(/g;
  while ((m = pyq.exec(text))) queueNames.add(m[1]);

  const parts = [];
  if (/priority_queue|PriorityQueue|heapq|TreeMap|TreeSet|Sorted(?:List|Dict|Set)|(?<![\w:])(?:std::)?(?:multi)?(?:map|set)\s*<|bisect|lower_bound|upper_bound|binary_search/.test(text)) {
    const hd =
      /\b(?:priority_queue|PriorityQueue|MinHeap|MaxHeap|TreeMap|TreeSet|SortedList|SortedDict|SortedSet)\b\s*(?:<[^;=(){}]*>)?\s*(\w+)|(?<![\w:])(?:std::)?(?:multi)?(?:map|set)\s*<[^;(){}]*>\s*(\w+)|\b(\w+)\s*=\s*(?:\w+\.)?Sorted(?:List|Dict|Set)\(/g;
    while ((m = hd.exec(text))) {
      const nm = m[1] || m[2] || m[3];
      heapNames.add(nm);
      queueNames.add(nm);
    }
    if (heapNames.size)
      parts.push(
        `\\b(?:${[...heapNames].map(esc).join("|")})\\s*(?:\\.|->)\\s*(?:push|pop|offer|poll|add|remove|emplace|put|get|insert|erase|find|count|containsKey|floorKey|ceilingKey|pollFirst|pollLast|lower_bound|upper_bound)\\b`,
      );
    parts.push(
      "\\bheapq\\s*\\.\\s*heap\\w+\\s*\\(|\\bheap(?:push|pop)\\s*\\(|\\bbisect\\w*\\s*\\(|\\b(?:lower_bound|upper_bound|binary_search)\\s*\\(",
    );
  }
  return { text, fam, alias, queueNames, heapNames, logOpRe: parts.length ? new RegExp(parts.join("|")) : null };
}

/* ───────────────────────── loop enrichment ───────────────────────── */

function pyIter(e) {
  e = (e || "").trim();
  let m = /^(?:enumerate|reversed|sorted|list|set|iter|tuple)\s*\(([\s\S]*)\)$/.exec(e);
  if (m) return pyIter(splitTop(m[1])[0]);
  m = /^zip\s*\(([\s\S]*)\)$/.exec(e);
  if (m) return pyIter(splitTop(m[1])[0]);
  m = /^range\s*\(([\s\S]*)\)$/.exec(e);
  if (m) {
    const a = splitTop(m[1]);
    return { range: a.length >= 2 ? a[1] : a[0] };
  }
  return e.replace(/\.\s*(?:items|keys|values)\(\)$/, "");
}

function parseHeader(L, fam) {
  const h = L.header || "";
  if (L.kind === "while" || L.kind === "do") {
    L.test = h;
    return;
  }
  if (L.kind === "iter") return;
  if (fam === PY || L.kind === "comp") {
    const m = /^\s*([\s\S]*?)\s+in\s+([\s\S]*?)\s*$/.exec(h);
    if (m) {
      L.var = lastIdent(m[1]);
      L.iter = pyIter(m[2]);
    }
    return;
  }
  const parts = splitTop(h, ";");
  if (parts.length >= 3) {
    L.init = parts[0];
    L.test = parts[1];
    L.update = parts[2];
    const vm = /([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(parts[0]);
    L.var = vm ? vm[1] : null;
    return;
  }
  L.init = "x";
  const m = /^([\s\S]*?)(?:\bof\b|\bin\b|(?<!:):(?!:))\s*([\s\S]*)$/.exec(h);
  if (m) {
    L.var = lastIdent(m[1]);
    L.iter = m[2].trim();
  }
}

/** Normalised loop-bound key: { id, coll } or null (unknown) or "const". */
function boundKey(L, ctx) {
  let expr = null;
  let fromIter = false;
  if (L.iter != null && L.iter !== undefined) {
    expr = L.iter;
    fromIter = true;
    if (typeof expr === "object") {
      expr = expr.range;
      fromIter = false;
    }
  } else if (L.kind === "for" && L.test) {
    const m = /^([\s\S]*?)(<=|>=|!=|<|>)([\s\S]*)$/.exec(L.test);
    if (m) {
      const [l, r] = [m[1], m[3]];
      const v = L.var;
      expr = v && new RegExp(`\\b${esc(v)}\\b`).test(r) && !new RegExp(`\\b${esc(v)}\\b`).test(l) ? l : r;
    }
  }
  if (expr == null) return null;
  let e = String(expr).trim();
  if (e === "") return "const"; // iterating a (blanked) literal
  e = e.replace(/Object\.(?:keys|values|entries)\(([^)]*)\)/, "$1")
    .replace(/\.\s*(?:slice|map|filter|keys|values|entries|split|reverse|concat|flat|toSorted)\b[\s\S]*$/, "")
    .replace(/^\(+|\)+$/g, "")
    .replace(/\s*[-+]\s*\d+\s*$/, "")
    .replace(/\s*\/\/?\s*\d+\s*$/, "")
    .trim();
  if (/^\d+$/.test(e)) return "const";
  if (/^\[/.test(e)) return "const";
  if (DIR_NAMES.test(e)) return "const";
  let m = /^len\(\s*([\w$.[\]]+)\s*\)$/.exec(e) || /^([\w$.[\]]+?)\s*\.\s*(?:length|size|count)\s*(?:\(\s*\))?$/.exec(e);
  if (m) return { id: ctx.alias[m[1]] || m[1], coll: true };
  m = /^([A-Za-z_$][\w$.[\]]*)$/.exec(e);
  if (m) {
    const al = ctx.alias[m[1]];
    return al ? { id: al, coll: true } : { id: m[1], coll: fromIter };
  }
  return null;
}

function sameDim(a, b) {
  if (!a || !b || typeof a === "string" || typeof b === "string") return true;
  if (a.id === b.id) return true;
  return a.coll !== b.coll; // scalar vs collection → assume same dimension
}

const geoRe = (x) => {
  const q = esc(x);
  return new RegExp(
    `\\b${q}\\s*(?:\\*=|\\/=|\\/\\/=|>>>?=|<<=)\\s*[1-9]\\d*|\\b${q}\\s*%=|\\b${q}\\s*=\\s*[^;=\\n]*?(?:\\b${q}\\s*(?:\\*|\\/\\/?|>>>?|<<)\\s*[1-9]\\d*|\\w+\\s*%\\s*\\w+)`,
  );
};
const modifiesRe = (x) => {
  const q = esc(x);
  return new RegExp(
    `\\b${q}\\s*(?:\\+\\+|--|\\+=|-=|\\*=|\\/=)|(?:\\+\\+|--)\\s*${q}\\b|\\b${q}\\s*=(?!=)|\\b${q}\\s*(?:\\.|->)\\s*(?:pop|pop_back|pop_front|popleft|shift|poll|pollFirst|pollLast|removeFirst|removeLast|remove|dequeue|erase|popitem)\\b|\\bdel\\s+${q}\\b`,
  );
};
// x is (re)assigned: x = …, x.clear(), and tuple / destructuring forms such as
// Python `l, r = i + 1, n - 1` or JS `[l, r] = [a, b]`.
const resetRe = (x) => {
  const q = esc(x);
  return new RegExp(
    `\\b${q}\\s*=(?!=)|\\b${q}\\s*(?:\\.|->)\\s*clear\\b|\\b${q}\\s*,[\\w\\s,]*=(?!=)|\\[[^\\]=\\n]*\\b${q}\\b[^\\]=\\n]*\\]\\s*=(?!=)`,
  );
};
const advanceRe = (x) => {
  const q = esc(x);
  return new RegExp(
    `\\b${q}\\s*(?:\\+\\+|--|\\+=|-=)|(?:\\+\\+|--)\\s*${q}\\b|\\b${q}\\s*=\\s*[^;\\n=]*?(?:next|Next|nxt|\\b${q}\\s*[-+]\\s*\\d)`,
  );
};

function enrichLoops(ir, ctx) {
  const { text, fam } = ctx;
  for (const L of ir.loops) {
    parseHeader(L, fam);
    const body = text.slice(L.bodyStart, L.end);
    const testIds = [...new Set(words(L.test))].filter((w) => !KEYWORDS.has(w)).slice(0, 8);
    const whileLike = L.kind === "while" || L.kind === "do" || (L.kind === "for" && !L.init);
    L.key = boundKey(L, ctx);

    // exponential bounds: for (mask = 0; mask < (1 << n); …), range(2 ** n), pow(2, n)
    const boundSrc = `${L.test || ""} ${typeof L.iter === "object" && L.iter ? L.iter.range : L.iter || ""}`;
    if (/\b1\s*<<\s*[A-Za-z_(]|\b(?:Math\s*\.\s*)?pow\s*\(\s*2\s*,|\b2\s*\*\*\s*[A-Za-z_(]/.test(boundSrc)) {
      L.weight = "exp";
      continue;
    }

    // constant-bound loops do not scale with input
    if (L.key === "const") {
      L.weight = "zero";
      continue;
    }
    // amortised inner loops (two pointers, sliding window, monotonic stack)
    if (L.parent && whileLike) {
      const pre = text.slice(L.parent.bodyStart, L.start);
      const post = text.slice(L.end, L.parent.end);
      const outerVars = words(L.parent.test || "").filter((w) => !KEYWORDS.has(w));
      for (const x of testIds) {
        if (!modifiesRe(x).test(body)) continue;
        if (resetRe(x).test(pre)) {
          // Run-length / grouping scan: j = i; while (…) j++; … i = j.
          // The outer index jumps past what the inner loop consumed, so the
          // total work stays linear.
          const jumps = outerVars.some(
            (p) =>
              new RegExp(`\\b${esc(x)}\\s*=\\s*${esc(p)}\\b`).test(pre) &&
              new RegExp(`\\b${esc(p)}\\s*=\\s*${esc(x)}\\b`).test(post),
          );
          if (!jumps) continue;
        }
        L.weight = "zero";
        L.amortized = true;
        break;
      }
      if (L.weight === "zero") continue;
    }
    // sqrt loops
    const tsrc = `${L.test || ""} ${typeof L.iter === "string" ? L.iter : ""}`;
    if (/(\b\w+)\s*\*\s*\1\b/.test(L.test || "") || /sqrt|\*\*\s*0?\.5/.test(tsrc)) {
      L.weight = "sqrt";
      continue;
    }
    // logarithmic loops
    const upd = `${body} ${L.update || ""}`;
    let isLog = false;
    const upIds = L.update ? words(L.update) : [];
    for (const x of new Set([...testIds, ...upIds])) {
      if (geoRe(x).test(upd)) { isLog = true; break; }
    }
    // Euclid-style reduction through a temporary or a tuple assignment:
    // t = a % b; a = b; b = t   /   a, b = b, a % b
    if (!isLog) {
      const modTemps = [];
      const mr = /\b([A-Za-z_$][\w$]*)\s*=(?!=)[^;\n=]*%[^;\n]*/g;
      let mt;
      while ((mt = mr.exec(body))) modTemps.push(mt[1]);
      isLog = testIds.some(
        (x) =>
          modTemps.some((t) => new RegExp(`\\b${esc(x)}\\s*=\\s*${esc(t)}\\s*(?:[;\\n]|$)`).test(body)) ||
          new RegExp(`(?:\\b${esc(x)}\\s*,[\\w\\s,]*|,\\s*${esc(x)}\\s*)=(?!=)[^\\n]*%`).test(body),
      );
    }
    if (!isLog && testIds.length >= 2) {
      const halves = [];
      const hr = /\b([A-Za-z_]\w*)\s*=\s*[^;\n=]*?(?:\/\/?\s*2\b|>>>?\s*1\b|\*\s*0\.5\b)/g;
      let m;
      while ((m = hr.exec(body))) halves.push(m[1]);
      if (halves.length) {
        const mids = halves.map(esc).join("|");
        isLog = testIds.some((x) => new RegExp(`\\b${esc(x)}\\s*=\\s*[^;\\n]*\\b(?:${mids})\\b`).test(body));
      }
    }
    if (isLog) {
      L.weight = "log";
      continue;
    }
    // parallel pointer loops: while (a || b || carry) / while (a && b)
    if (L.kind === "while" && L.test) {
      const orT = splitTop(L.test.replace(/\|\||\bor\b/g, "\u0001"), "\u0001");
      const andT = splitTop(L.test.replace(/&&|\band\b/g, "\u0001"), "\u0001");
      for (const [terms, tag] of [[orT, "or"], [andT, "and"]]) {
        if (terms.length < 2) continue;
        const sets = terms.map((t) => words(t).filter((w) => !KEYWORDS.has(w) && advanceRe(w).test(body)));
        const live = sets.filter((s) => s.length);
        if (live.length >= 2 && live[0].every((w) => !live[1].includes(w))) {
          L.parallel = tag === "or" ? "max" : "sum";
          break;
        }
      }
    }
    if (ctx.logOpRe && ctx.logOpRe.test(body)) L.logOp = true;
  }
}

/* ───────────────────────── per-function analysis ───────────────────────── */

const chainAdd = (c, L) => {
  if (L.weight === "zero") return c;
  const n = { ...c };
  if (L.logOp) n.logOp = true;
  if (L.weight === "exp") n.exp = (c.exp || 0) + 1;
  else if (L.weight === "log") n.log++;
  else if (L.weight === "sqrt") n.sq++;
  else {
    n.lin++;
    n.keys = c.keys.concat([L.key]);
    if (L.parallel) n.special = L.parallel;
  }
  return n;
};
const chainRank = (c) => (c.exp ? 1e5 * c.exp : 0) + c.lin * 10 + c.log + (c.logOp ? 1 : 0) + c.sq * 5;

function chainToCx(c) {
  if (c.exp) {
    const poly = c.lin ? `${c.lin === 1 ? "n" : `n^${c.lin}`} × ` : "";
    return { ...mk(c.lin), label: `O(${poly}2^n)`, rank: 1e5 * c.exp + c.lin * 10 };
  }
  const groups = [];
  for (const k of c.keys) {
    const g = groups.find((x) => sameDim(x.key, k));
    if (g) g.n++;
    else groups.push({ key: k, n: 1 });
  }
  return mk(c.lin, c.log + (c.logOp ? 1 : 0), {
    sq: c.sq,
    dims: groups.length > 1 ? groups.map((g) => g.n) : null,
    special: c.lin === 1 && !c.log ? c.special : null,
    multiDim: groups.length > 1,
  });
}

function stateParamCount(fn) {
  if (!fn.params.length) return 1;
  let k = 0;
  fn.params.forEach((p, i) => {
    if (
      fn.selfCalls.some((c) => {
        const a = c.args[i];
        return a !== undefined && a.replace(/^\s*[A-Za-z_]\w*\s*=(?!=)\s*/, "").replace(/[\s&*]/g, "") !== p;
      })
    ) k++;
  });
  return Math.max(1, k);
}

function boundedDepth(fn, ctx) {
  if (fn._bd !== undefined) return fn._bd;
  fn._bd = null;
  const { text } = ctx;
  const body = text.slice(fn.bodyStart, fn.end);
  fn.params.forEach((p, i) => {
    if (fn._bd) return;
    const dec = new RegExp(`^${esc(p)}\\s*-\\s*1$`);
    if (!fn.selfCalls.every((c) => c.args[i] !== undefined && dec.test(c.args[i].replace(/^\s*\w+\s*=(?!=)\s*/, "").trim()))) return;
    const re = new RegExp(`(?<![\\w.>:$])${esc(fn.name)}\\s*\\(|(?:\\bthis\\s*(?:->|\\.)|\\bself\\.|\\b\\w+::)${esc(fn.name)}\\s*\\(`, "g");
    const lits = [];
    let m;
    while ((m = re.exec(text))) {
      if (m.index >= fn.hdrStart && m.index < fn.end) continue;
      const open = m.index + m[0].length - 1;
      const r = matchForward(text, open);
      if (r < 0) continue;
      lits.push((splitTop(text.slice(open + 1, r))[i] || "").trim());
    }
    if (!lits.length || !lits.every((a) => /^\d+$/.test(a) && Number(a) <= 20)) return;
    const bm = new RegExp(`\\b${esc(p)}\\s*(?:==|<=)\\s*(\\d+)`).exec(body);
    fn._bd = { D: Math.max(...lits.map(Number)), b: bm ? Number(bm[1]) : 0 };
  });
  return fn._bd;
}

const inLoop = (L, pos) => pos >= L.bodyStart && pos < L.end;

function analyzeRecursion(fn, ctx) {
  // A call that only normalises its input (f(x, -n), f(abs(n))) is not a
  // subproblem: it does not shrink anything and runs at most once.
  const isNormalization = (k) =>
    k.args.length > 0 &&
    k.args.some((a, i) => a.replace(/\s/g, "") !== fn.params[i]) &&
    k.args.every((a, i) => {
      const t = a.replace(/\s/g, "");
      const p = fn.params[i];
      return p !== undefined && (t === p || t === `-${p}` || new RegExp(`^(?:std::|Math\\.)?abs\\(${esc(p)}\\)$`).test(t));
    });
  const calls = fn.selfCalls.filter((k) => !isNormalization(k));
  if (!calls.length) return null;
  const { text } = ctx;
  const body = text.slice(fn.bodyStart, fn.end);
  const argText = calls.map((c) => c.args.join(",")).join(";");
  const driven = calls.filter((k) => fn.loops.some((L) => inLoop(L, k.pos))).length;
  const retCalls = calls.filter((k) => /\breturn\s*\(?\s*$/.test(text.slice(Math.max(0, k.pos - 24), k.pos))).length;
  const ce = calls.length - retCalls + (retCalls ? 1 : 0); // mutually exclusive returned calls count once

  let work = 0;
  for (const L of fn.loops) {
    if (calls.some((k) => inLoop(L, k.pos))) continue;
    let d = 0;
    for (let p = L; p; p = p.parent)
      if (!calls.some((k) => inLoop(p, k.pos)) && p.weight === "lin") d++;
    work = Math.max(work, d);
  }
  const copy = COPY_RE.test(argText) || /\bmerge\s*\(/.test(body);
  if (copy && work === 0) work = 1;

  const memo = MEMO_RE.test(body) || MEMO_RE.test(fn.deco);
  const halvingVars = [];
  const hRe = /\b([A-Za-z_$][\w$]*)\s*=[^;\n]*?(?:\/\/?\s*2\b|>>>?\s*1\b|\*\s*0\.5\b|\bmid\b|\bmiddle\b|\bhalf\b)/g;
  let hm;
  while ((hm = hRe.exec(body))) halvingVars.push(hm[1]);
  // A call halves the problem only if it shrinks a parameter (n / 2, lo..mid)
  // or passes a midpoint; dividing a local (a carry digit s / 10) does not.
  const params = new Set(fn.params);
  const argHalves = (a) => {
    if (/\bmid\b|\bmiddle\b|\bhalf\b|\*\s*0\.5\b/.test(a)) return true;
    const dm = /([A-Za-z_$][\w$]*)\s*(?:\/\/?\s*(?:[2-9]|\d{2,})\b|>>>?\s*\d)/.exec(a);
    return !!dm && params.has(dm[1]);
  };
  const halving =
    calls.some((k) => k.args.some(argHalves)) ||
    (halvingVars.length > 0 &&
      halvingVars.some((v) => new RegExp(`\\b${esc(v)}\\b`).test(argText)));
  const step = STEP_RE.test(argText);
  const out = { cx: ZERO_CX, aux: ZERO_CX, pat: "", ev: [], conf: HIGH };

  // Grid flood fill: calls move to a neighbouring cell (r ± 1, c ± 1, r + dr…)
  // and the cell is marked, so every cell is processed once in total.
  const neighbourArg = (a) =>
    /^\s*[A-Za-z_$][\w$]*\s*[-+]\s*1\s*$/.test(a) ||
    /^\s*[A-Za-z_$][\w$]*\s*[-+]\s*[A-Za-z_$][\w$]*\s*\[[^\]]*\]\s*$/.test(a) ||
    /^\s*[A-Za-z_$][\w$]*\s*\+\s*(?:d[rcxyij]|dr|dc|dx|dy)\b/.test(a) ||
    /^\s*n(?:r|c|x|y|i|j|ew_?r|ew_?c)\s*$/i.test(a);
  const cellWrite = /\b[A-Za-z_$][\w$]*\s*\[[^\]\n]+\]\s*\[[^\]\n]+\]\s*=(?!=)/.test(body);
  const neighbourCalls = calls.filter((k) => k.args.some(neighbourArg)).length;
  // A cell written again after the recursive calls is restored (backtracking,
  // e.g. word search): cells are revisited, so this is not a flood fill.
  const lastCall = Math.max(...calls.map((k) => k.pos)) - fn.bodyStart;
  const restoresCell = /\b[A-Za-z_$][\w$]*\s*\[[^\]\n]+\]\s*\[[^\]\n]+\]\s*=(?!=)/.test(body.slice(lastCall));
  const flood =
    !memo &&
    !restoresCell &&
    (cellWrite || (GRAPH_RE.test(body) && /\[[^\]\n]+\]\s*\[[^\]\n]+\]/.test(body))) &&
    ((calls.length >= 2 && neighbourCalls >= 2) || (driven > 0 && GRID_RE.test(body) && neighbourCalls >= 1));
  if (flood) {
    out.cx = mk(2, 0, { dims: [1, 1] });
    out.aux = mk(2, 0, { dims: [1, 1] });
    out.pat = "grid_flood_fill";
    out.ev.push("Grid DFS / flood fill marks each cell as visited: every cell is processed once (n × m cells, recursion depth up to n × m)");
    out.conf = MED;
    return out;
  }

  if (memo) {
    const k = stateParamCount(fn);
    const d = Math.max(0, ...fn.loops.filter((L) => L.weight === "lin").map((L) => L.depth));
    const dims = k === 2 ? [1, 1] : [k];
    if (d) dims.push(d);
    out.cx = mk(k + d, 0, { dims: dims.length > 1 ? dims : null });
    out.aux = mk(k, 0, { dims: k === 2 ? [1, 1] : null });
    out.pat = "memoized_dynamic_programming";
    out.ev.push("Recursion with memoization: each distinct state is computed once", `State parameters: ${k}${d ? `, per-state loop depth: ${d}` : ""}`);
    out.conf = k === 1 && !d ? HIGH : MED;
  } else if (halving) {
    const e = Math.log2(Math.max(ce, 1));
    if (work < e - 1e-9) out.cx = Number.isInteger(e) ? mk(e) : mk(0, 0, { label: `O(n^${e.toFixed(2)})`, rank: Math.round(e * 10) });
    else if (Math.abs(work - e) < 1e-9) out.cx = mk(work, 1);
    else out.cx = mk(work);
    out.aux = copy || (ce >= 2 && /\bmerge\b/.test(body)) ? mk(1) : mk(0, 1);
    out.pat = ce === 1 && work === 0 ? "binary_search_recursion" : "divide_and_conquer";
    out.ev.push(`Divide-and-conquer recurrence: ${ce} subproblem(s) of half size, ${work ? `work per level O(n${work > 1 ? `^${work}` : ""})` : "O(1) work per level"}`);
    out.conf = HIGH;
  } else if (GRAPH_RE.test(body)) {
    out.cx = { ...mk(1), label: "O(V + E)", rank: 10.5 };
    out.aux = { ...mk(1), label: "O(V)", rank: 10.5 };
    out.pat = "depth_first_search";
    out.ev.push("DFS with visited tracking: each vertex and edge handled once");
  } else if (TREE_RE.test(argText) && !PERM_RE.test(body)) {
    out.cx = mk(1 + work);
    out.aux = { ...mk(1), label: "O(h)", rank: 9 };
    out.pat = "tree_traversal";
    out.ev.push("Recursive traversal over tree/graph children: each node visited once (n = nodes, h = height)");
    out.conf = work ? MED : HIGH;
  } else if ((driven > 0 || ce >= 2) && boundedDepth(fn, ctx)) {
    const { D, b } = boundedDepth(fn, ctx);
    out.cx = mk(Math.max(1, D - b + work));
    out.aux = ZERO_CX;
    out.pat = "bounded_depth_recursion";
    out.ev.push(`Recursion depth is bounded by a constant (${D}) that shrinks by 1 per call; ${D - b} branching level(s) plus O(n^${work}) work at the base`);
    out.conf = MED;
  } else if (driven > 0 || ce >= 2) {
    // Permutation-style backtracking (N-Queens, permutations): the loop runs
    // over all choices from a fixed start and marks the chosen ones. A loop
    // starting at a parameter (start, idx) enumerates combinations instead.
    const callLoop = fn.loops.find((L) => calls.some((k) => inLoop(L, k.pos)));
    const loopStart = callLoop
      ? callLoop.init
        ? (callLoop.init.split("=")[1] || "").trim()
        : (/range\s*\(\s*([^,)]+)\s*,/.exec(callLoop.header || "") || [])[1] || "0"
      : "";
    const startsAtParam = fn.params.some((p) => new RegExp(`^${esc(p)}\\b`).test(loopStart));
    const marks = /\b[A-Za-z_$][\w$]*\s*\[[^\]\n]+\]\s*=\s*(?:[^;\n]*=\s*)?(?:true|false|True|False|1|0)\b/.test(body);
    const perm = driven > 0 && (PERM_RE.test(body) || (marks && !startsAtParam));
    const base = driven > 0 ? 2 : ce;
    out.cx = perm ? { ...mk(1), label: "O(n!)", rank: 1e6 } : { ...mk(1), label: base === 2 ? "O(2^n)" : `O(${base}^n)`, rank: 1e5 + base };
    out.aux = mk(1);
    out.pat = driven > 0 ? "backtracking" : "branching_recursion";
    out.ev.push(driven > 0 ? "Recursive call inside a loop without memoization (backtracking)" : `Branching recursion (${ce} calls per state) without memoization`);
    out.conf = step || driven > 0 ? HIGH : LOW;
  } else if (/%/.test(argText)) {
    out.cx = mk(0, 1);
    out.aux = mk(0, 1);
    out.pat = "binary_search_recursion";
    out.ev.push("Single recursive call with modulo reduction (Euclid-style)");
    out.conf = MED;
  } else {
    out.cx = mk(1 + work);
    out.aux = mk(1);
    out.pat = "linear_recursion";
    out.ev.push("Single linear recursive descent");
    out.conf = step ? HIGH : MED;
  }
  return out;
}

/**
 * True when a sort runs on a fixed-size literal (sorted((a, b, c)), or a
 * container initialised from a small literal), so it does not scale with n.
 * Plain indexing such as nums[i] is NOT a literal initialiser.
 */
function isConstantSort(text, pos) {
  const open = text.indexOf("(", pos);
  const r = open < 0 ? -1 : matchForward(text, open);
  const firstArg = r > 0 ? (splitTop(text.slice(open + 1, r))[0] || "").trim() : "";
  const back = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(text.slice(Math.max(0, pos - 40), pos));
  // sorted((a, b, c)) / sort([x, y]) - not a method call, whose first
  // argument would be a comparator such as (a, b) => a - b.
  if (!back && /^[([{]/.test(firstArg) && !/\bfor\b|=>|\blambda\b/.test(firstArg)) {
    return (firstArg.match(/,/g) || []).length < 16;
  }
  const x = back ? back[1] : firstArg ? lastIdent(firstArg.replace(/\.\s*(?:begin|rbegin|end|rend)\(\)/g, "")) : null;
  if (!x) return false;
  const q = esc(x);
  const m = new RegExp(
    `\\b${q}\\s*(?:\\[\\s*\\d*\\s*\\])?\\s*=\\s*[\\[{]([^\\]}]*)[\\]}]|(?:<[^;()]*>|\\b\\w+)\\s+${q}\\s*\\{([^}]*)\\}`,
  ).exec(text);
  if (!m) return false;
  const literal = m[1] ?? m[2] ?? "";
  // x = [] / x = {} start empty and grow, so they are not fixed-size
  return /\S/.test(literal) && !/\bfor\b/.test(literal) && (literal.match(/,/g) || []).length < 16;
}

/**
 * Positions (absolute) of slice / substring / array copies in text[from, to)
 * whose length can grow with the input: s[i:j], s[1:], s[::-1], x.slice(),
 * s.substring(i, j), s.substr(i), Arrays.copyOf(…). Fixed-length copies
 * (s[:3], x.slice(0, 2), s.substr(i, 2)) are skipped.
 */
function copyOps(text, fam, from, to) {
  const out = [];
  const seg = text.slice(from, to);
  const lit = (s) => /^\s*-?\d+\s*$/.test(s || "");
  // A copy in a return statement runs once, not once per iteration.
  const inReturn = (i) => /^\s*return\b/.test(seg.slice(seg.lastIndexOf("\n", i) + 1, i));
  let m;
  if (fam === PY) {
    const re = /\[([^[\]\n]*)\]/g;
    while ((m = re.exec(seg))) {
      const parts = m[1].split(":");
      if (parts.length < 2 || parts.length > 3) continue;
      if (!/[\w\])]/.test(seg[m.index - 1] || "")) continue; // indexing, not a list literal
      const [a, b] = parts;
      if ((lit(a) || !a.trim()) && lit(b)) continue; // fixed length
      if (inReturn(m.index)) continue;
      out.push(from + m.index);
    }
    return out;
  }
  const re = /\.\s*(slice|substring|substr|concat)\s*\(([^()\n]*)\)|\b(?:Arrays\s*\.\s*)?copyOf(?:Range)?\s*\(/g;
  while ((m = re.exec(seg))) {
    if (m[1]) {
      const args = splitTop(m[2] || "");
      if (m[1] === "substr" && lit(args[1])) continue;
      if ((m[1] === "slice" || m[1] === "substring") && args.length === 2 && lit(args[0]) && lit(args[1])) continue;
    }
    if (inReturn(m.index)) continue;
    out.push(from + m.index);
  }
  return out;
}

/**
 * Library calls that cost O(n) on a sequence: C++ algorithms over iterators,
 * C string routines, Python built-ins over one collection, string/array
 * methods. Returns absolute positions in text[from, to). Calls that are
 * O(1) (max(a, b), set.count(x)) or already counted as loops (generator
 * expressions, JS map/filter) are excluded.
 */
function libraryOps(text, fam, from, to) {
  const out = [];
  const seg = text.slice(from, to);
  let m;
  const push = (i) => out.push(from + i);
  if (fam === PY) {
    const re = /(?<![\w.])(sum|max|min|any|all|list|set|tuple|dict|Counter)\s*\(|\.\s*(join|split|count|index|reverse|copy|strip|lower|upper|replace|find)\s*\(/g;
    while ((m = re.exec(seg))) {
      if (m[1]) {
        const open = from + m.index + m[0].length - 1;
        const r = matchForward(text, open);
        if (r < 0) continue;
        const args = splitTop(text.slice(open + 1, r)).filter((a) => !/^\s*\w+\s*=(?!=)/.test(a));
        if (args.length !== 1 || /\bfor\b/.test(args[0]) || /^\s*[[({'"\d]/.test(args[0])) continue;
      }
      push(m.index);
    }
    return out;
  }
  if (fam === JS) {
    const re = /\.\s*(?:reverse|includes|indexOf|lastIndexOf|join|split|fill|toUpperCase|toLowerCase|trim|repeat)\s*\(|\bMath\s*\.\s*(?:max|min)\s*\(\s*\.\.\.|\bArray\s*\.\s*from\s*\(|\bnew\s+(?:Set|Map)\s*\(\s*[A-Za-z_$]|\[\s*\.\.\./g;
    while ((m = re.exec(seg))) push(m.index);
    return out;
  }
  const re = /(?<![\w.>:])(?:std::)?(?:reverse|accumulate|count|count_if|find|find_if|max_element|min_element|fill|copy|unique|rotate|iota|equal|is_sorted|partial_sum|transform|any_of|all_of|none_of|replace|remove|remove_if)\s*\(\s*[A-Za-z_][\w.\->]*?\s*(?:\.|->)\s*c?r?begin\s*\(|(?<![\w.])(?:strlen|memset|memcpy|memmove|strcpy|strcmp|strcat|strncmp)\s*\(|\b(?:Arrays\s*\.\s*(?:fill|stream|equals|asList)|Collections\s*\.\s*(?:reverse|max|min|frequency)|String\s*\.\s*join)\s*\(|\.\s*(?:toCharArray|split|indexOf|toUpperCase|toLowerCase|trim)\s*\(/g;
  while ((m = re.exec(seg))) push(m.index);
  return out;
}

function analyzeFn(fn, ctx) {
  const ev = [];
  const pats = [];
  let conf = HIGH;
  const loops = fn.loops;
  const fnBody = ctx.text.slice(fn.bodyStart, fn.end);
  const cands = [];

  // queue / stack driven traversals (BFS, iterative DFS, level order, topo sort)
  for (const L of loops) {
    if (L.parent && L.parent.skip) { L.skip = true; continue; }
    if (L.kind === "while" && L.test && words(L.test).some((w) => ctx.queueNames.has(w))) {
      L.skip = true;
      const seg = ctx.text.slice(L.bodyStart, L.end);
      const visited = GRAPH_RE.test(fnBody);
      const grid = GRID_RE.test(seg);
      const heap = words(L.test).some((w) => ctx.heapNames.has(w) || /^(?:pq|heap|priority)/i.test(w));
      let cx;
      if (!visited) cx = mk(1);
      else if (grid) cx = heap ? mk(2, 1, { dims: [1, 1] }) : mk(2, 0, { dims: [1, 1] });
      else cx = heap ? { ...mk(1, 1), label: "O((V + E) log V)", rank: 11 } : { ...mk(1), label: "O(V + E)", rank: 10.5 };
      cands.push({ cx, pat: /stack|stk/i.test(L.test) ? "depth_first_search" : "breadth_first_search", ev: `Queue/stack driven traversal${visited ? " with visited tracking" : ""}`, conf: visited ? HIGH : MED });
    }
  }

  // loop nests
  const chains = new Map();
  let best = EMPTY_CHAIN;
  let amortized = false;
  for (const L of loops) {
    if (L.skip) continue;
    const c = chainAdd(L.parent ? chains.get(L.parent) || EMPTY_CHAIN : EMPTY_CHAIN, L);
    chains.set(L, c);
    if (L.amortized) amortized = true;
    if (chainRank(c) > chainRank(best)) best = c;
  }
  fn.chains = chains;
  let chainCx = chainToCx(best);
  if (best.lin === 1 && !best.log && !best.special) {
    const tops = loops.filter((L) => !L.skip && !L.parent && L.weight === "lin");
    const keys = tops.map((L) => L.key);
    if (tops.length >= 2 && keys.some((k, i) => i && !sameDim(keys[0], k) && keys[0] && k)) {
      chainCx = { ...chainCx, special: "sum" };
      conf = Math.min(conf, MED);
    }
  }
  if (best.lin || best.log || best.sq || best.exp) {
    const lg = best.log + (best.logOp ? 1 : 0);
    let p = "linear_traversal";
    if (best.exp) p = "bitmask_enumeration";
    else if (best.special && best.lin === 1) p = "parallel_linked_list_traversal";
    else if (best.lin >= 3) p = "multi_nested_loops";
    else if (best.lin === 2) p = chainCx.multiDim ? "nested_independent_loops" : "nested_loops";
    else if (best.lin === 0 && lg) p = "binary_search";
    else if (best.sq && !best.lin) p = "sqrt_loop";
    else if (chainCx.special === "sum") p = "sequential_independent_loops";
    else if (best.logOp) p = "heap_operations";
    cands.push({
      cx: chainCx, pat: p, conf,
      ev: `Loop nest: ${best.exp ? "2^n (bitmask) iterations, " : ""}${best.lin} linear${best.log ? `, ${best.log} logarithmic` : ""}${best.sq ? `, ${best.sq} sqrt` : ""} level(s)${best.logOp ? ", O(log n) heap/ordered-set operation per iteration" : ""}`,
    });
    if (chainCx.multiDim) conf = Math.min(conf, MED);
  }
  if (amortized) {
    pats.push("amortized_inner_loop");
    ev.push("Inner while loop advances a pointer/stack monotonically (amortized O(1) per outer step)");
  }

  // sorting
  for (const pos of fn.sorts) {
    if (isConstantSort(ctx.text, pos)) continue;
    let c = EMPTY_CHAIN;
    for (const L of loops) if (!L.skip && inLoop(L, pos) && chains.get(L) && chainRank(chains.get(L)) >= chainRank(c)) c = chains.get(L);
    const withSort = { ...c, lin: c.lin + 1, log: c.log + 1, keys: c.keys.concat([null]) };
    cands.push({ cx: chainToCx(withSort), pat: c.lin ? "sorting_with_linear_pass" : "standard_sort", ev: "Comparison sort (O(n log n))", conf: HIGH });
  }

  // copies inside a scaling loop cost O(length) per iteration
  for (const pos of copyOps(ctx.text, ctx.fam, fn.bodyStart, fn.end)) {
    let c = null;
    for (const L of loops) {
      const lc = chains.get(L);
      if (!L.skip && pos >= L.bodyStart && pos < L.end && lc && (!c || chainRank(lc) >= chainRank(c))) c = lc;
    }
    if (!c || !c.lin) continue;
    cands.push({
      cx: chainToCx({ ...c, lin: c.lin + 1, keys: c.keys.concat([null]) }),
      pat: "copy_in_loop",
      ev: "Slice/substring copy inside a loop costs O(length) per iteration",
      conf: MED,
    });
  }

  // O(n) library calls: once at top level, per iteration inside a scaling loop
  // (body, or a loop condition that is re-evaluated every iteration).
  const inner = (pos) => {
    let c = EMPTY_CHAIN;
    for (const L of loops) {
      const lc = chains.get(L);
      if (!L.skip && lc && pos >= L.bodyStart && pos < L.end && chainRank(lc) >= chainRank(c)) c = lc;
    }
    return c;
  };
  for (const pos of libraryOps(ctx.text, ctx.fam, fn.bodyStart, fn.end)) {
    if (ctx.fns && fnAt(ctx.fns, ctx.root, pos) !== fn) continue; // belongs to a nested function
    const c = inner(pos);
    cands.push({
      cx: chainToCx({ ...c, lin: c.lin + 1, keys: c.keys.concat([null]) }),
      pat: c.lin ? "library_call_in_loop" : "library_linear_call",
      ev: c.lin ? "O(n) library call inside a loop" : "O(n) library call",
      conf: MED,
    });
  }
  for (const L of loops) {
    if (L.skip || !(L.kind === "while" || (L.kind === "for" && L.init)) || !L.test) continue;
    if (!libraryOps(L.test, ctx.fam, 0, L.test.length).length) continue;
    const c = chains.get(L) || EMPTY_CHAIN;
    cands.push({
      cx: chainToCx({ ...c, lin: c.lin + 1, keys: c.keys.concat([null]) }),
      pat: "library_call_in_loop_condition",
      ev: "O(n) library call re-evaluated in a loop condition on every iteration",
      conf: MED,
    });
  }

  // recursion
  fn.rec = analyzeRecursion(fn, ctx);
  if (fn.rec) cands.push({ cx: fn.rec.cx, pat: fn.rec.pat, ev: fn.rec.ev.join("; "), conf: fn.rec.conf });

  let top = null;
  for (const c of cands) if (!top || rank(c.cx) > rank(top.cx)) top = c;
  if (!top) {
    fn.cx = ZERO_CX;
    fn.info = { ev, pats: ["constant_time_operations"], conf: HIGH, evMain: "No loops or recursion detected" };
    return;
  }
  for (const c of cands) if (!pats.includes(c.pat)) pats.push(c.pat);
  fn.cx = top.cx;
  fn.info = { ev, pats, conf: Math.min(conf, top.conf), evMain: top.ev };
}

/** A non-recursive helper called inside a loop multiplies its cost into the caller. */
function applyHelperCalls(ir, ctx) {
  const callees = ir.fns.filter(
    (f) => f !== ir.root && !f.selfCalls.length && /^[A-Za-z_$][\w$]*$/.test(f.name) && f.cx && rank(f.cx) > 0,
  );
  if (!callees.length) return;
  const byName = new Map(callees.map((f) => [f.name, f]));
  const re = new RegExp(`(?<![\\w.$])(?:${[...byName.keys()].map(esc).join("|")})\\s*\\(`, "g");
  let m;
  while ((m = re.exec(ctx.text))) {
    const callee = byName.get(m[0].replace(/\s*\($/, ""));
    const caller = fnAt(ir.fns, ir.root, m.index);
    if (!callee || caller === callee || !caller.chains) continue;
    let c = null;
    for (const L of caller.loops) {
      const lc = caller.chains.get(L);
      if (lc && !L.skip && inLoop(L, m.index) && (!c || chainRank(lc) > chainRank(c))) c = lc;
    }
    if (!c) continue;
    const total = sumCx(chainToCx(c), callee.cx);
    if (total && rank(total) > rank(caller.cx)) {
      caller.cx = total;
      caller.info.pats.push("helper_called_in_loop");
      caller.info.evMain = `Helper "${callee.name}" (${label(callee.cx)}) is called inside a loop of depth ${c.lin}`;
      caller.info.conf = Math.min(caller.info.conf, MED);
    }
  }
}

function computeTime(entry) {
  const { ir, ctx } = entry;
  enrichLoops(ir, ctx);
  ctx.fns = ir.fns;
  ctx.root = ir.root;
  for (const f of ir.fns) analyzeFn(f, ctx);
  applyHelperCalls(ir, ctx);
  let top = ir.root;
  for (const f of ir.fns) if (rank(f.cx) > rank(top.cx)) top = f;
  const pats = [];
  for (const f of ir.fns) for (const p of f.info.pats) if (!pats.includes(p) && p !== "constant_time_operations") pats.push(p);
  const conf = top.info.conf;
  const lbl = label(top.cx);
  const evidence = [top.info.evMain, ...top.info.ev];
  return {
    bestEstimate: lbl,
    confidence: CONF[conf],
    asymptoticClass: classOf(lbl),
    evidence,
    patterns: pats.length ? pats : ["constant_time_operations"],
    rank: rank(top.cx),
    cx: top.cx,
    topFn: top,
  };
}

/* ───────────────────────── space analysis ───────────────────────── */

const SMALL = (s) => /^\s*\d+\s*$/.test(s) && Number(s) <= 1024;
const ALLOC_RES = [
  /\bnew\s+(?!\w*Node\b)[\w.]+(?:\s*<[^>;]*>)?\s*((?:\[[^\]\n]*\]\s*)+)/g,
  /\bArray\s*\(\s*([^)]+)\)/g,
  /\bArray\.from\s*\(\s*\{\s*length\s*:\s*([^}]+)\}/g,
  /\bvector\s*<[^;(){}]*>\s*\w*\s*\(\s*([^,;(){}]+)/g,
  // Python list multiplication [0] * n - the [...] must be a literal list,
  // not an index expression such as A[i][k] * B.
  /(?:^|[=(,:\s[])\[[^\]\n]*\]\s*\*\s*(\([^)]*\)|[\w.$]+)/g,
  /\b(?:int|long|bool|char|double|float|string)\s+\w+\s*((?:\[[^\]\n]+\]\s*)+)/g,
];
// Growth: x.push(…) / x[key] = … (one level of nested brackets, e.g.
// seen[nums[i]] = i) / heapq.heappush(x, …) / bisect.insort(x, …).
const GROW_RE =
  /\b([A-Za-z_$][\w$]*)\s*(?:\.|->)\s*(?:push_back|push|append|add|set|insert|emplace_back|emplace|put|offer|enqueue|extend|appendleft|addLast|addFirst)\s*\(|\b([A-Za-z_$][\w$]*)\s*(?:\[(?:[^[\]\n]|\[[^\]\n]*\])*\]\s*(?:=(?!=)|\+=)|\+=)|\b(?:heapq\s*\.\s*)?(?:heappush|heappushpop|insort(?:_left|_right)?)\s*\(\s*([A-Za-z_$][\w$]*)/g;
const DECL_RES = [
  /\b([A-Za-z_$][\w$]*)\s*(?::[^=\n;]+)?=\s*(?:\[\s*\]|\{\s*\}|new\s+(?:Map|Set|Array|WeakMap)\b|set\s*\(\s*\)|dict\s*\(\s*\)|list\s*\(\s*\)|(?:collections\.)?(?:deque|defaultdict|Counter|OrderedDict)\s*\(|\[[^\]\n]*\]\s*\*|\[[^\]\n]*\bfor\b|new\s+(?!\w*Node\b)\w+(?:<[^>;]*>)?\s*[([])/g,
  /\b(?:vector|unordered_map|unordered_set|map|set|multiset|multimap|deque|queue|stack|priority_queue|list|string|bitset)\s*(?:<[^;(){}]*>)?\s+([A-Za-z_]\w*)\s*(?=[;(=[{])/g,
  /\b(?:List|ArrayList|LinkedList|Map|HashMap|TreeMap|LinkedHashMap|Set|HashSet|TreeSet|LinkedHashSet|Deque|ArrayDeque|Queue|PriorityQueue|Stack|StringBuilder|Vector)\s*(?:<[^;(){}=]*>)?\s+([A-Za-z_]\w*)\s*(?=[;=])/g,
];
// `return x` returns the container x; `return x.top()` / `x.toString()` /
// `x->val` / `x[0]` return something derived from it, not x itself.
const RET_RE = /\breturn\s+(?:\(\s*)?([A-Za-z_$][\w$]*)(?!\s*(?:[[(\w$.]|->))/g;
const NODE_ALLOC = /\bnew\s+\w*Node\s*[([]/g;

function computeSpace(entry, time) {
  const { ir, ctx } = entry;
  const { text } = ctx;
  const ev = [];
  let aux = ZERO_CX;
  let out = ZERO_CX;
  let conf = HIGH;
  const bump = (cur, c) => (rank(c) > rank(cur) ? c : cur);

  // recursion + traversal containers
  for (const f of ir.fns) {
    if (f.rec && rank(f.rec.aux) > rank(aux)) {
      aux = f.rec.aux;
      ev.push(`Recursion stack / state storage: ${label(aux)}`);
    }
    if (f.info.pats.includes("breadth_first_search") || f.info.pats.includes("depth_first_search")) {
      const t = f.loops.some((L) => L.skip && GRID_RE.test(text.slice(L.bodyStart, L.end)));
      const c = t ? mk(2, 0, { dims: [1, 1] }) : { ...mk(1), label: "O(V)", rank: 10 };
      if (rank(c) > rank(aux)) {
        aux = c;
        ev.push("Queue/stack and visited tracking");
      }
    }
  }

  // Only what the entry function returns is output. Containers returned by
  // helpers (build(s) in backspaceCompare) are temporaries of the caller.
  const calledElsewhere = (f) => {
    const re = new RegExp(`(?<![\\w$])${esc(f.name)}\\s*\\(`, "g");
    let cm;
    while ((cm = re.exec(text))) if (cm.index < f.hdrStart || cm.index >= f.end) return true;
    return false;
  };
  const named = ir.fns.filter((f) => f !== ir.root && /^[A-Za-z_$][\w$]*$/.test(f.name));
  const helpers = new Set(named.filter(calledElsewhere));
  const returned = new Set();
  let m;
  RET_RE.lastIndex = 0;
  while ((m = RET_RE.exec(text))) {
    if (!helpers.has(fnAt(ir.fns, ir.root, m.index))) returned.add(m[1]);
  }
  // The entry function returns a value (return dummy.next, return reverse(head), …):
  // nodes it allocates per iteration form that result.
  let returnsValue = false;
  const rv = /\breturn\s+[^;\s}]/g;
  while ((m = rv.exec(text))) {
    if (!helpers.has(fnAt(ir.fns, ir.root, m.index))) { returnsValue = true; break; }
  }
  const growsAt = (pos) => ir.loops.some((L) => inLoop(L, pos)) || ir.fns.some((f) => f.selfCalls.length && pos >= f.bodyStart && pos < f.end);
  const loopSpecial = (pos) => {
    let sp = null;
    for (const L of ir.loops) if (L.parallel && inLoop(L, pos)) sp = L.parallel;
    return sp;
  };
  const place = (name, c, why, pos) => {
    if (name && returned.has(name)) {
      const sp = pos !== undefined ? loopSpecial(pos) : null;
      const oc = sp && c.lin === 1 ? { ...c, special: sp } : c;
      if (rank(oc) > rank(out)) { out = oc; ev.push(`Output space: ${why}`); }
    } else if (rank(c) > rank(aux)) {
      aux = bump(aux, c);
      ev.push(`Auxiliary space: ${why}`);
    }
    conf = Math.min(conf, MED);
  };

  // sized allocations
  const lines = text.split("\n");
  let off = 0;
  for (const ln of lines) {
    const here = off;
    off += ln.length + 1;
    if (!/[[(]/.test(ln)) continue;
    let sizes = [];
    for (const re of ALLOC_RES) {
      re.lastIndex = 0;
      while ((m = re.exec(ln))) {
        const g = m[1];
        sizes.push(...(g.includes("[") ? g.match(/\[[^\]]*\]/g).map((s) => s.slice(1, -1)) : [g]));
      }
    }
    if (/\[[^\n]*\bfor\b[^\n]*\brange\s*\(\s*([^)]*)\)/.test(ln)) {
      const r = /\bfor\s+\w+\s+in\s+range\s*\(\s*([^)]*)\)/g;
      while ((m = r.exec(ln))) sizes.push(m[1]);
    }
    sizes = sizes.filter((s) => s.trim() && !/^(?:const\s+)?(?:int|long|vector|string|auto|char|bool|double|float|unsigned|size_t)\b/.test(s.trim()));
    if (!sizes.length || sizes.every(SMALL)) continue;
    const dims = sizes.filter((s) => !SMALL(s)).length;
    const nm = /([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]\s*)*(?::[^=\n]+)?=(?!=)/.exec(ln) || /(?:>|\w)\s+([A-Za-z_]\w*)\s*[([{]/.exec(ln);
    const c = dims >= 2 ? mk(dims, 0, { dims: dims === 2 ? [1, 1] : null }) : mk(1);
    place(nm ? nm[1] : null, c, `${dims}-dimensional allocation sized by input`, here);
  }

  // growing containers
  const decls = new Set();
  for (const re of DECL_RES) {
    re.lastIndex = 0;
    while ((m = re.exec(text))) decls.add(m[1]);
  }
  GROW_RE.lastIndex = 0;
  const seen = new Set();
  while ((m = GROW_RE.exec(text))) {
    const nm = m[1] || m[2] || m[3];
    if (seen.has(nm) || !growsAt(m.index)) continue;
    if ((m[2] || m[3]) && !decls.has(nm)) continue;
    seen.add(nm);
    place(nm, mk(1), `container "${nm}" grows with input`, m.index);
  }
  // node allocation per iteration
  const nodeRe = ctx.fam === PY ? /(?<![\w.])(?:ListNode|TreeNode|Node)\s*\(/g : NODE_ALLOC;
  nodeRe.lastIndex = 0;
  while ((m = nodeRe.exec(text))) {
    if (/\b(?:class|def|struct|function)\s+$/.test(text.slice(Math.max(0, m.index - 10), m.index))) continue;
    if (growsAt(m.index)) {
      const sp = loopSpecial(m.index);
      const c = sp ? { ...mk(1), special: sp } : mk(1);
      if (returnsValue) { if (rank(c) > rank(out)) { out = c; ev.push("Output space: new nodes allocated per iteration"); } }
      else if (rank(c) > rank(aux)) { aux = c; ev.push("Auxiliary space: new nodes allocated per iteration"); }
      conf = Math.min(conf, MED);
      break;
    }
  }
  // a slice/substring copy made inside a scaling loop needs O(n) memory
  for (const f of ir.fns) {
    const pos = copyOps(text, ctx.fam, f.bodyStart, f.end).find((p) =>
      f.loops.some((L) => !L.skip && L.weight !== "zero" && L.weight !== "exp" && p >= L.bodyStart && p < L.end),
    );
    if (pos === undefined) continue;
    const lineStart = text.lastIndexOf("\n", pos) + 1;
    const asg = /([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?!=)/.exec(text.slice(lineStart, pos));
    place(asg ? asg[1] : null, mk(1), "slice/substring copy inside a loop", pos);
  }
  if (/\bsorted\s*\(|\btoSorted\s*\(/.test(text) && rank(aux) < 10) {
    aux = mk(1);
    ev.push("sorted() returns a new list");
  }

  const total = rank(out) >= rank(aux) ? out : aux;
  return {
    auxiliary: label(aux),
    output: label(out),
    total: label(total),
    confidence: CONF[conf],
    evidence: ev.length ? ev : ["Only scalar variables / in-place updates detected"],
  };
}

/* ───────────────────────── dynamic evidence ───────────────────────── */

function correlateDynamicEvidence(testcases, evidenceScope, timeRank, includePoints) {
  const pts = (Array.isArray(testcases) ? testcases : [])
    .map((tc, i) => ({
      caseIndex: i + 1,
      inputBytes: Number(tc.inputBytes ?? tc.sizeBytes ?? Buffer.byteLength(String(tc.stdin ?? tc.input ?? ""), "utf-8")),
      cpuTimeMs: Number(tc.cpuTimeMs ?? tc.timeMs ?? 0),
      memoryKb: Number(tc.memoryKb ?? tc.memory ?? 0),
      status: tc.status || (tc.passed ? "Accepted" : "Failed"),
    }))
    .filter((p) => p.status !== "Compilation Error");
  const base = { scope: evidenceScope, testcaseCount: pts.length };
  if (!pts.length) return { ...base, timeModelFit: { model: "inconclusive", confidence: "low" }, memoryTrend: "unknown" };

  const maxT = Math.max(...pts.map((p) => p.cpuTimeMs));
  const mem = pts.map((p) => p.memoryKb);
  const memoryTrend = Math.max(...mem) - Math.min(...mem) > 4096 ? "growing" : "flat_baseline";
  let fit = { model: "inconclusive", confidence: "low" };
  const sizes = [...new Set(pts.map((p) => p.inputBytes))].filter((s) => s > 0);
  if (maxT <= 5) fit = { model: "below_timer_resolution", confidence: "low" };
  else if (sizes.length >= 3 && Math.max(...sizes) / Math.min(...sizes) >= 4) {
    const xs = [], ys = [];
    for (const p of pts) if (p.inputBytes > 0 && p.cpuTimeMs > 0) { xs.push(Math.log(p.inputBytes)); ys.push(Math.log(p.cpuTimeMs)); }
    if (xs.length >= 3) {
      const mx = xs.reduce((a, b) => a + b) / xs.length;
      const my = ys.reduce((a, b) => a + b) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
      if (sxx > 0) {
        const slope = sxy / sxx;
        const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
        const model = slope < 0.35 ? "constant_or_logarithmic" : slope < 1.4 ? "linear_or_linearithmic" : slope < 2.4 ? "quadratic" : "super_quadratic";
        const isFewCases = pts.length < 6 || xs.length < 5 || Math.max(...sizes) < 200;
        const dynConfidence = !isFewCases && r2 > 0.9 ? "high" : "medium";
        fit = { model, slope: +slope.toFixed(2), r2: +r2.toFixed(2), confidence: dynConfidence };
        const expected = timeRank < 1e4 ? Math.floor(timeRank / 10) + (timeRank % 10 ? 0.1 : 0) : null;
        if (expected !== null) base.agreement = Math.abs(slope - expected) <= 0.6 ? "consistent" : "divergent";
      }
    }
  }
  const res = { ...base, timeModelFit: fit, memoryTrend, maxTimeMs: maxT, maxMemoryKb: Math.max(...mem) };
  if (includePoints) res.dataPoints = pts;
  return res;
}

/* ───────────────────────── public API ───────────────────────── */

function getEntry(code, language) {
  const norm = code.includes("\r") ? code.replace(/\r\n?/g, "\n") : code;
  const lang = String(language || "").toLowerCase().trim();
  const fam = /^(?:js|jsx|javascript|node|nodejs|ts|tsx|typescript)$/.test(lang)
    ? JS
    : /^(?:py|python|python2|python3|pypy|pypy3)$/.test(lang) ? PY : BRACE;
  const key = `${fam}\u0001${/^t/.test(lang) ? "t" : ""}\u0001${norm}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const text = stripSource(norm, fam);
  let ir;
  if (fam === JS) {
    try {
      ir = buildAstIR(norm, text, /^t/.test(lang));
    } catch {
      ir = buildBraceIR(text);
    }
  } else ir = fam === PY ? buildPyIR(text) : buildBraceIR(text);
  const entry = { ir, ctx: buildCtx(text, fam), time: null, space: null };
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry;
}

function unknownResult(reason, compat) {
  const r = {
    version: ANALYZER_VERSION,
    status: "unknown",
    summary: "Complexity analysis unavailable",
    limitations: [reason],
  };
  if (!compat) return r;
  const t = { bestEstimate: "Unknown", confidence: "unknown", evidence: [reason], asymptoticClass: "UNKNOWN" };
  const s = { bestEstimate: "Unknown", auxiliary: "Unknown", output: "Unknown", total: "Unknown", totalAdditional: "Unknown", confidence: "unknown", evidence: [reason] };
  return {
    ...r, analysisVersion: ANALYZER_VERSION, analysisStatus: "unknown",
    time: t, space: s, timeComplexity: { value: "Unknown", ...t, reasoning: [reason] },
    spaceComplexity: { ...s, reasoning: [reason] },
    dynamicEvidence: { scope: "static_only", testcaseCount: 0, dataPoints: [], timeModelFit: { model: "none", confidence: "unknown" }, memoryTrend: "unknown", notes: [] },
    assumptions: [],
  };
}

/**
 * @param {object} p
 * @param {string} p.code
 * @param {string} p.language
 * @param {Array<"time"|"space"|"dynamic">} [p.include] Parts to compute and return (default: all).
 *        "dynamic" only runs when testcases are supplied.
 * @param {boolean} [p.verbose]  Include evidence strings and per-testcase points.
 * @param {boolean} [p.compat]   Legacy response shape (aliases, evidence, assumptions…).
 */
export async function analyzeComplexity({
  code,
  language,
  executionResult = null,
  testcases = [],
  evidenceScope = "static_only",
  include = ["time", "space", "dynamic"],
  verbose = false,
  compat = false,
}) {
  if (!code || typeof code !== "string" || !code.trim()) return unknownResult("Source code was empty or whitespace only", compat);
  if (code.length > MAX_CODE_LENGTH) return unknownResult("Source code too large to analyze", compat);

  const want = new Set(include);
  const full = verbose || compat;

  // Check deterministic hash cache first for fast static retrieval
  const hashKey = computeComplexityHash(code, language, ANALYZER_VERSION);
  let staticData = staticAnalysisCache.get(hashKey);

  if (!staticData) {
    let entry;
    try {
      entry = getEntry(code, language);
      if (!entry.time) entry.time = computeTime(entry);
    } catch (err) {
      return unknownResult(`Parsing error encountered: ${err.message}`, compat);
    }
    const t = entry.time;
    if (!entry.space) entry.space = computeSpace(entry, t);
    const s = entry.space;

    const summaryParts = [];
    if (t?.bestEstimate) summaryParts.push(`Time: ${t.bestEstimate}`);
    if (s) summaryParts.push(`Space: ${s.auxiliary} auxiliary, ${s.output} output (${s.total} total)`);

    const timeOut = { bestEstimate: t.bestEstimate, confidence: t.confidence, asymptoticClass: t.asymptoticClass };
    const spaceOut = { bestEstimate: s.auxiliary, auxiliary: s.auxiliary, output: s.output, total: s.total, confidence: s.confidence };

    const baseResult = {
      version: ANALYZER_VERSION,
      status: "completed",
      summary: summaryParts.join(", "),
      time: { ...timeOut },
      detectedPatterns: t.patterns,
      space: { ...spaceOut },
    };

    staticData = {
      t,
      s,
      summary: summaryParts.join(", "),
      timeOut,
      spaceOut,
      patterns: t.patterns,
      timeEvidence: t.evidence,
      spaceEvidence: s.evidence,
      rank: t.rank,
      baseResult,
    };

    if (staticAnalysisCache.size >= MAX_STATIC_CACHE_ENTRIES) {
      const oldestKey = staticAnalysisCache.keys().next().value;
      staticAnalysisCache.delete(oldestKey);
    }
    staticAnalysisCache.set(hashKey, staticData);
  }

  const isDefaultQuery =
    (!testcases || testcases.length === 0) &&
    !verbose &&
    !compat &&
    executionResult === null &&
    include.length === 3 &&
    include.includes("time") &&
    include.includes("space") &&
    include.includes("dynamic");

  if (isDefaultQuery && staticData.baseResult) {
    return staticData.baseResult;
  }

  const { t, s, summary, timeOut, spaceOut, patterns, timeEvidence, spaceEvidence, rank: tRank } = staticData;

  // Separate dynamic evidence computation from static analysis
  const dyn =
    (want.has("dynamic") || compat) && Array.isArray(testcases) && testcases.length
      ? correlateDynamicEvidence(testcases, evidenceScope, tRank, full)
      : null;

  const res = { version: ANALYZER_VERSION, status: "completed", summary };
  if (want.has("time") || compat) {
    res.time = { ...timeOut };
    if (full) {
      const ev = [...timeEvidence];
      if (executionResult?.timeMs !== undefined) ev.push(`Empirical runtime: ${executionResult.timeMs}ms (benchmark only)`);
      res.time.evidence = ev;
    }
    res.detectedPatterns = patterns;
  }
  if (want.has("space") || compat) {
    res.space = { ...spaceOut };
    if (full) {
      const ev = [...spaceEvidence];
      if (executionResult?.memoryKb !== undefined) res.space.evidence.push(`Empirical peak memory: ${executionResult.memoryKb} KB (benchmark only)`);
      res.space.evidence = ev;
    }
  }
  if (dyn) res.dynamicEvidence = dyn;

  if (compat) {
    res.analysisVersion = ANALYZER_VERSION;
    res.analysisStatus = "completed";
    res.space.totalAdditional = s.total;
    res.timeComplexity = { value: t.bestEstimate, ...res.time, reasoning: res.time.evidence };
    res.spaceComplexity = { auxiliary: s.auxiliary, output: s.output, total: s.total, totalAdditional: s.total, confidence: s.confidence, evidence: res.space.evidence, reasoning: res.space.evidence };
    res.dynamicEvidence = dyn || { scope: evidenceScope, testcaseCount: 0, dataPoints: [], timeModelFit: { model: "none", confidence: "unknown" }, memoryTrend: "unknown", notes: [] };
    res.assumptions = [];
    res.limitations = [];
    res.analyzedAt = new Date().toISOString();
  }
  return res;
}