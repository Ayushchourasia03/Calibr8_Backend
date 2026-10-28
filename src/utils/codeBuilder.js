import { ApiError } from "./ApiError.js";

/**
 * Supported language canonical keys and Judge0 Language IDs
 */
export const LANGUAGE_IDS = {
  python: 71,       // Python 3.10
  javascript: 63,   // JavaScript Node.js 22
  js: 63,
  cpp: 54,          // C++ GCC 13
  c: 50,            // C GCC 13
  java: 62,         // Java OpenJDK 17
};

export const SUPPORTED_LANGUAGES = ["cpp", "c", "java", "python", "javascript"];

/**
 * Normalizes language string to canonical identifier.
 * Returns null if the language is unsupported (avoids silent fallback to Python).
 *
 * @param {string} lang
 * @returns {string|null} Canonical language key or null
 */
export function normalizeLanguage(lang) {
  if (!lang) return null;
  const l = String(lang).trim().toLowerCase();
  if (l === "cpp" || l === "c++") return "cpp";
  if (l === "c") return "c";
  if (l === "java") return "java";
  if (l === "python" || l === "py" || l === "python3") return "python";
  if (l === "javascript" || l === "js" || l === "node" || l === "nodejs") return "javascript";
  return null;
}

/**
 * Extracts clean userTemplate for a given language from problem templates.
 * Returns only the function signature for the student editor (no headers/footers).
 *
 * @param {object} problem
 * @param {string} language
 * @returns {string} Clean starter template for user editor
 */
export function getUserTemplate(problem, language) {
  const lang = normalizeLanguage(language) || "cpp";
  let tmpl = problem?.templatesMap?.[lang] ?? problem?.templates?.[lang];

  if (!tmpl && Array.isArray(problem?.templates)) {
    const found = problem.templates.find(
      (t) => normalizeLanguage(t.language) === lang
    );
    if (found) {
      tmpl = found;
    }
  }

  if (!tmpl) {
    return getDefaultUserTemplate(problem, lang);
  }

  // If stored as structured object { userTemplate, header, footer }
  if (typeof tmpl === "object" && tmpl !== null) {
    return tmpl.userTemplate || tmpl.code || getDefaultUserTemplate(problem, lang);
  }

  // If stored as JSON string
  if (typeof tmpl === "string") {
    const trimmed = tmpl.trim();
    if (trimmed.startsWith("{") && (trimmed.includes("userTemplate") || trimmed.includes("code"))) {
      try {
        const parsed = JSON.parse(trimmed);
        return parsed.userTemplate || parsed.code || getDefaultUserTemplate(problem, lang);
      } catch {}
    }
    return trimmed;
  }

  return getDefaultUserTemplate(problem, lang);
}

/**
 * Provides a fallback starter template when no explicit template exists
 */
export function getDefaultUserTemplate(problem, lang) {
  const slug = (problem?.slug || "solution").replace(/-\d+$/, "").replace(/-/g, "_");
  const camelSlug = (problem?.slug || "solution")
    .replace(/-\d+$/, "")
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  if (lang === "cpp") {
    if (slug.includes("linked_list") || slug.includes("add_two") || slug.includes("list")) {
      return `ListNode* ${camelSlug}(ListNode* l1, ListNode* l2) {\n    // Write your code here\n}\n`;
    }
    return `class Solution {\npublic:\n    // Write your code here\n};\n`;
  }
  if (lang === "c") {
    if (slug.includes("linked_list") || slug.includes("add_two") || slug.includes("list")) {
      return `struct ListNode* ${camelSlug}(struct ListNode* l1, struct ListNode* l2) {\n    // Write your code here\n}\n`;
    }
    return `// Write your function here\n`;
  }
  if (lang === "java") {
    return `class Solution {\n    // Write your code here\n}\n`;
  }
  if (lang === "python") {
    return `class Solution:\n    def ${slug}(self, *args):\n        # Write your code here\n        pass\n`;
  }
  if (lang === "javascript") {
    return `class Solution {\n    ${camelSlug}(...args) {\n        // Write your code here\n    }\n}\n`;
  }
  return `// Write your function here\n`;
}

/**
 * Generic header/footer synthesizers for common DSA problems when problem.json
 * does not specify custom header/footer.
 */
function getSynthesizedWrapper(problem, userCode, lang) {
  const slug = (problem?.slug || "").toLowerCase();
  const isLinkedList =
    slug.includes("linked-list") ||
    slug.includes("list") ||
    slug.includes("node") ||
    (problem?.topic && String(problem.topic).toLowerCase().includes("linked list"));

  if (lang === "cpp") {
    const isNode = userCode.includes("Node*") || userCode.includes("Node *") || slug.includes("circular");
    let structDef = "";
    if (isLinkedList) {
      structDef = isNode
        ? `struct Node {\n    int data;\n    Node* next;\n    Node(int x) : data(x), next(nullptr) {}\n};\n`
        : `struct ListNode {\n    int val;\n    ListNode* next;\n    ListNode() : val(0), next(nullptr) {}\n    ListNode(int x) : val(x), next(nullptr) {}\n    ListNode(int x, ListNode *next) : val(x), next(next) {}\n};\n`;
    }

    // Omit struct definition from header if user code already defines it
    if (userCode.includes("struct ListNode") || userCode.includes("class ListNode")) {
      structDef = "";
    }

    const header = `#include <bits/stdc++.h>\n#include <iostream>\n#include <vector>\n#include <string>\n#include <sstream>\n#include <unordered_map>\n#include <algorithm>\nusing namespace std;\n\n${structDef}`;

    // If no footer provided, synthesize a basic driver if user hasn't supplied main()
    const footer = `\n// Driver code provided by Calibr8 platform\n`;

    return { header, footer };
  }

  if (lang === "c") {
    let structDef = "";
    if (isLinkedList && !userCode.includes("struct ListNode")) {
      structDef = `struct ListNode {\n    int val;\n    struct ListNode* next;\n};\nstatic struct ListNode* createListNode(int val) {\n    struct ListNode* n = (struct ListNode*)malloc(sizeof(struct ListNode));\n    n->val = val; n->next = NULL; return n;\n}\n`;
    }

    const header = `#include <stdio.h>\n#include <stdlib.h>\n#include <stdbool.h>\n#include <string.h>\n\n${structDef}`;
    const footer = `\n// Driver code provided by Calibr8 platform\n`;
    return { header, footer };
  }

  if (lang === "java") {
    let structDef = "";
    if (isLinkedList && !userCode.includes("class ListNode")) {
      structDef = `class ListNode {\n    int val;\n    ListNode next;\n    ListNode() {}\n    ListNode(int x) { val = x; }\n    ListNode(int x, ListNode n) { val = x; next = n; }\n}\n`;
    }

    const header = `import java.util.*;\nimport java.io.*;\n\n${structDef}`;
    const footer = `\n`;
    return { header, footer };
  }

  if (lang === "javascript") {
    let structDef = "";
    if (isLinkedList && !userCode.includes("class ListNode")) {
      structDef = `class ListNode {\n    constructor(val = 0, next = null) {\n        this.val = val;\n        this.next = next;\n    }\n}\n`;
    }
    const footer = `
try {
  const _fs = require('fs');
  const _raw = _fs.readFileSync(0, 'utf8');
  const _lines = _raw.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
  const _parsed = _lines.map(l => {
    try {
      return JSON.parse(l);
    } catch (e) {
      const parts = l.split(/\\s+/);
      if (parts.length > 1 && parts.every(p => !isNaN(p))) {
        return parts.map(Number);
      }
      if (parts.length === 1 && !isNaN(parts[0])) {
        return Number(parts[0]);
      }
      return l;
    }
  });

  let _fn = null;
  if (typeof Solution !== 'undefined') {
    try {
      const _sol = new Solution();
      const _proto = Object.getPrototypeOf(_sol);
      const _methods = Object.getOwnPropertyNames(_proto).filter(m => m !== 'constructor');
      if (_methods.length > 0 && typeof _sol[_methods[0]] === 'function') {
        _fn = _sol[_methods[0]].bind(_sol);
      }
    } catch (_) {}
  }
  if (!_fn && typeof solve === 'function') _fn = solve;
  if (!_fn && typeof solution === 'function') _fn = solution;

  if (_fn) {
    const _expectedCount = _fn.length;
    let _finalArgs = _parsed;

    if (_expectedCount > 0 && _parsed.length > _expectedCount) {
      if (_parsed.length === _expectedCount + 1 && typeof _parsed[0] === 'number') {
        _finalArgs = _parsed.slice(1);
      }
    }
    if (_expectedCount === 1 && _finalArgs.length > 1) {
      if (typeof _finalArgs[0] === 'number' && Array.isArray(_finalArgs[1])) {
        _finalArgs = [_finalArgs[1]];
      }
    }

    const _res = _fn(..._finalArgs);
    if (Array.isArray(_res)) {
      console.log(_res.join(' '));
    } else {
      console.log(_res);
    }
  }
} catch (_err) {
  process.stderr.write(String(_err));
  process.exit(1);
}
`;
    return { header: structDef, footer };
  }

  if (lang === "python") {
    let structDef = "";
    if (isLinkedList && !userCode.includes("class ListNode")) {
      structDef = `from typing import List, Optional\nimport sys, json\n\nclass ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n`;
    } else {
      structDef = `from typing import List, Optional\nimport sys, json\n`;
    }

    const footer = `
# Driver code provided by Calibr8 platform
try:
    _raw_stdin = sys.stdin.read()
    _lines = [l.strip() for l in _raw_stdin.split('\\n') if l.strip()]
    _parsed_lines = []
    for _line in _lines:
        try:
            _parsed_lines.append(json.loads(_line))
        except Exception:
            _parts = _line.split()
            if len(_parts) > 1 and all(p.lstrip('-').isdigit() for p in _parts):
                _parsed_lines.append([int(p) for p in _parts])
            elif len(_parts) == 1 and _parts[0].lstrip('-').isdigit():
                _parsed_lines.append(int(_parts[0]))
            else:
                _parsed_lines.append(_line)

    _fn = None
    if 'Solution' in globals() and callable(globals()['Solution']):
        _sol = Solution()
        _methods = [m for m in dir(_sol) if not m.startswith('_') and callable(getattr(_sol, m))]
        if _methods:
            _fn = getattr(_sol, _methods[0])
    if _fn is None:
        _funcs = [v for k, v in list(globals().items()) if not k.startswith('_') and callable(v) and k not in ('Solution', 'sys', 'json', 'traceback')]
        if _funcs:
            _fn = _funcs[-1]

    if _fn is not None:
        import inspect
        _sig = inspect.signature(_fn)
        _param_names = [p.name for p in _sig.parameters.values() if p.name != 'self']
        _expected_count = len(_param_names)
        _final_args = _parsed_lines

        if len(_parsed_lines) > _expected_count and _expected_count > 0:
            if len(_parsed_lines) == _expected_count + 1 and isinstance(_parsed_lines[0], int):
                _final_args = _parsed_lines[1:]

        if _expected_count == 1 and len(_final_args) > 1:
            if isinstance(_final_args[0], int) and isinstance(_final_args[1], list):
                _final_args = [_final_args[1]]

        _result = _fn(*_final_args)
        if isinstance(_result, bool):
            print(str(_result).lower())
        elif isinstance(_result, list):
            print(" ".join(str(x) for x in _result))
        else:
            print(_result)
except Exception as _e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
`;
    return { header: structDef, footer };
  }

  return { header: "", footer: "" };
}

/**
 * Builds final executable source code from problem templates and user function code.
 * Enforces function-only submission for function problems: rejects submissions containing main().
 *
 * Structure for C++/C/Java:
 * 1. Platform support code (headers, includes, type definitions such as ListNode)
 * 2. User solution function or class
 * 3. Driver or harness (platform main() that parses stdin and outputs result)
 *
 * @param {object} problem
 * @param {string} userCode
 * @param {string} language
 * @returns {string} Complete executable source code
 */
export function buildFinalCode(problem, userCode, language) {
  if (typeof userCode !== "string" || !userCode.trim()) {
    throw new ApiError(400, "Code is required.", "MISSING_CODE");
  }

  const lang = normalizeLanguage(language);
  if (!lang) {
    throw new ApiError(
      422,
      `Unsupported language: '${language}'. Supported languages: ${SUPPORTED_LANGUAGES.join(", ")}.`,
      "UNSUPPORTED_LANGUAGE"
    );
  }

  const isStdioProblem =
    problem?.submissionModel === "stdio" ||
    problem?.submissionModel === "stdin" ||
    problem?.submissionModel === "standard";

  // Enforce function-only: users must never be required to write main()
  if (!isStdioProblem) {
    const hasMain =
      /\bmain\s*\(/.test(userCode) ||
      /\bint\s+main\b/.test(userCode) ||
      /\bvoid\s+main\b/.test(userCode) ||
      /\bdef\s+main\b/.test(userCode);

    if (hasMain) {
      throw new ApiError(
        400,
        "Do not write main(), only write the required function solution.",
        "FUNCTION_ONLY_REQUIRED"
      );
    }
  }

  // Look up template in problem
  let tmpl = problem?.templatesMap?.[lang] ?? problem?.templates?.[lang];

  if (!tmpl && Array.isArray(problem?.templates)) {
    const match = problem.templates.find(
      (t) => normalizeLanguage(t.language) === lang
    );
    if (match) {
      if (match.header || match.footer) {
        tmpl = match;
      } else if (match.code) {
        tmpl = match.code;
      }
    }
  }

  // If stored as JSON string
  if (typeof tmpl === "string" && tmpl.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(tmpl.trim());
      if (parsed.header !== undefined || parsed.footer !== undefined) {
        tmpl = parsed;
      }
    } catch {}
  }

  // 1. Problem has structured template { header, footer, userTemplate }
  if (tmpl && typeof tmpl === "object") {
    let header = tmpl.header || "";
    const footer = tmpl.footer || "";

    // Prevent duplicate type definitions only if user code actually DEFINES the struct or class
    if (
      /struct\s+ListNode\s*\{/.test(header) &&
      (/struct\s+ListNode\s*\{/.test(userCode) || /class\s+ListNode\s*\{/.test(userCode))
    ) {
      header = header.replace(/struct\s+ListNode\s*\{[^}]*\};?\s*/g, "");
    }

    let bridge = "";
    if (lang === "python") {
      bridge = `
# Calibr8 Model A / Model B Bridge
try:
    if 'Solution' in globals():
        _sol_inst = None
        for _attr in dir(Solution):
            if not _attr.startswith('_') and callable(getattr(Solution, _attr)):
                if _attr not in globals():
                    if _sol_inst is None:
                        try: _sol_inst = Solution()
                        except Exception: pass
                    if _sol_inst and hasattr(_sol_inst, _attr):
                        globals()[_attr] = getattr(_sol_inst, _attr)
    else:
        class Solution: pass
        for _k, _v in list(globals().items()):
            if not _k.startswith('_') and callable(_v) and _k not in ('ListNode', 'Node', 'sys', 'json', 'traceback', 'inspect'):
                setattr(Solution, _k, staticmethod(_v))
except Exception:
    pass
`;
    } else if (lang === "javascript") {
      bridge = `
// Calibr8 Model A / Model B Bridge
if (typeof Solution !== 'undefined') {
  try {
    const _solInst = new Solution();
    const _proto = Object.getPrototypeOf(_solInst);
    for (const _m of Object.getOwnPropertyNames(_proto)) {
      if (_m !== 'constructor' && typeof _solInst[_m] === 'function' && typeof globalThis[_m] === 'undefined') {
        globalThis[_m] = _solInst[_m].bind(_solInst);
      }
    }
  } catch (_) {}
}
`;
    } else if (lang === "cpp") {
      if (userCode.includes("class Solution") && userCode.includes("addTwoNumbers") && !/ListNode\*\s+addTwoNumbers\s*\(/.test(userCode.replace(/class\s+Solution[\s\S]*?\};/, ""))) {
        bridge = `\nListNode* addTwoNumbers(ListNode* l1, ListNode* l2) {\n    Solution sol;\n    return sol.addTwoNumbers(l1, l2);\n}\n`;
      }
    }

    return `${header.trim()}\n\n${userCode.trim()}\n\n${bridge.trim()}\n\n${footer.trim()}\n`;
  }

  // 2. Synthesize wrapper if problem lacks explicit header/footer
  const syn = getSynthesizedWrapper(problem, userCode, lang);
  return `${syn.header.trim()}\n\n${userCode.trim()}\n\n${syn.footer.trim()}\n`;
}