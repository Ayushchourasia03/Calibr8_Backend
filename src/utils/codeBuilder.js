import { ApiError } from "./ApiError.js";

/**
 * Standard Judge0 Language IDs
 */
export const LANGUAGE_IDS = {
  python: 71,       // Python 3.10
  javascript: 63,   // JavaScript Node.js 22
  js: 63,
  cpp: 54,          // C++ GCC 13
  c: 50,            // C GCC 13
  java: 62,         // Java OpenJDK 17
};

/**
 * Normalizes language string
 */
export function normalizeLanguage(lang) {
  const l = String(lang || "").trim().toLowerCase();
  if (l === "js" || l === "node" || l === "nodejs") return "javascript";
  if (l === "py" || l === "python3") return "python";
  if (l === "c++") return "cpp";
  return l || "python";
}

/**
 * Extracts clean userTemplate for a given language from problem templates.
 * Returns only the function signature for the student editor (no headers/footers).
 */
export function getUserTemplate(problem, language) {
  const lang = normalizeLanguage(language);
  const tmpl = problem?.templatesMap?.[lang] ?? problem?.templates?.[lang];

  if (!tmpl) {
    return getDefaultUserTemplate(problem, lang);
  }

  if (typeof tmpl === "object" && tmpl !== null) {
    return tmpl.userTemplate || tmpl.code || getDefaultUserTemplate(problem, lang);
  }

  // If stored as string
  return String(tmpl);
}

/**
 * Provides a fallback starter template when no explicit template exists
 */
export function getDefaultUserTemplate(problem, lang) {
  const slug = (problem?.slug || "solution").replace(/-\d+$/, "").replace(/-/g, "_");
  const camelSlug = (problem?.slug || "solution")
    .replace(/-\d+$/, "")
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  if (lang === "python") {
    return `class Solution:\n    def ${slug}(self, *args):\n        # Write your code here\n        pass\n`;
  }
  if (lang === "javascript") {
    return `class Solution {\n    ${camelSlug}(...args) {\n        // Write your code here\n    }\n}\n`;
  }
  if (lang === "cpp") {
    return `class Solution {\npublic:\n    // Write your code here\n};\n`;
  }
  if (lang === "c") {
    return `// Write your function here\n`;
  }
  if (lang === "java") {
    return `class Solution {\n    // Write your code here\n}\n`;
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
    (problem?.topic && problem.topic.toLowerCase().includes("linked list"));

  if (lang === "cpp") {
    const isNode = userCode.includes("Node*") || userCode.includes("Node *") || slug.includes("circular");
    const structDef = isNode
      ? `struct Node { int data; Node* next; Node(int x){data=x; next=NULL;} };\n`
      : `struct ListNode { int val; ListNode* next; ListNode() : val(0), next(nullptr) {} ListNode(int x) : val(x), next(nullptr) {} ListNode(int x, ListNode *next) : val(x), next(next) {} };\n`;

    return {
      header: `#include <bits/stdc++.h>\n#include <iostream>\n#include <vector>\n#include <string>\n#include <sstream>\n#include <unordered_map>\n#include <algorithm>\nusing namespace std;\n\n${structDef}`,
      footer: `\n// Driver code provided by Calibr8 platform\n`
    };
  }

  if (lang === "c") {
    return {
      header: `#include <stdio.h>\n#include <stdlib.h>\n#include <stdbool.h>\n#include <string.h>\n\nstruct Node { int data; struct Node* next; };\nstruct ListNode { int val; struct ListNode* next; };\n`,
      footer: `\n// Driver code provided by Calibr8 platform\n`
    };
  }

  if (lang === "java") {
    return {
      header: `import java.util.*;\nimport java.io.*;\n\nclass ListNode { int val; ListNode next; ListNode(int x) { val = x; } }\nclass Node { int data; Node next; Node(int d) { data = d; } }\n`,
      footer: `\n`
    };
  }

  if (lang === "javascript") {
    return {
      header: `class ListNode { constructor(val = 0, next = null) { this.val = val; this.next = next; } }\nclass Node { constructor(data) { this.data = data; this.next = null; } }\n`,
      footer: `\n`
    };
  }

  if (lang === "python") {
    return {
      header: `import sys, json\nfrom typing import List, Optional\n\nclass ListNode:\n    def __init__(self, val=0, next=None):\n        self.val = val\n        self.next = next\n\nclass Node:\n    def __init__(self, data):\n        self.data = data\n        self.next = None\n`,
      footer: `\n`
    };
  }

  return { header: "", footer: "" };
}

/**
 * Builds final executable source code from problem templates and user function code.
 * Enforces function-only submission: rejects submissions containing main().
 *
 * @param {object} problem
 * @param {string} userCode
 * @param {string} language
 * @returns {string} Complete source code with driver
 */
export function buildFinalCode(problem, userCode, language) {
  if (typeof userCode !== "string" || !userCode.trim()) {
    throw new ApiError(400, "Code is required.", "MISSING_CODE");
  }

  // 1. Basic check: user should write only function, not main()
  if (userCode.includes("main(") || userCode.includes("main (")) {
    throw new ApiError(
      400,
      "Do not write main(), only write the required function solution.",
      "FUNCTION_ONLY_REQUIRED"
    );
  }

  const lang = normalizeLanguage(language);
  const tmpl = problem?.templatesMap?.[lang] ?? problem?.templates?.[lang];

  // 2. Structured template in problem JSON { header, footer, userTemplate }
  if (tmpl && typeof tmpl === "object") {
    const header = tmpl.header || "";
    const footer = tmpl.footer || "";
    return `${header}\n${userCode}\n${footer}`;
  }

  // 3. Fallback: Synthesize wrapper if no explicit header/footer
  const syn = getSynthesizedWrapper(problem, userCode, lang);
  return `${syn.header}\n${userCode}\n${syn.footer}`;
}
