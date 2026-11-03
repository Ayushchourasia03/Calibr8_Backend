import crypto from "crypto";
import * as babelParser from "@babel/parser";

const ANALYZER_VERSION = "1.0.0";
const MAX_CACHE_ENTRIES = 500;
const complexityCache = new Map();

/**
 * Computes a deterministic cache key for a submission analysis
 */
function getCacheKey(code, language, slug = "") {
  const normalized = String(code || "").trim().replace(/\r\n/g, "\n");
  const hash = crypto
    .createHash("sha256")
    .update(`${language}:${slug}:${ANALYZER_VERSION}:${normalized}`)
    .digest("hex");
  return hash;
}

/**
 * JavaScript AST Analyzer using @babel/parser
 */
function analyzeJavaScriptAst(code) {
  let maxLoopDepth = 0;
  let currentLoopDepth = 0;
  let hasLogarithmicStep = false;
  let hasSortingCall = false;
  let recursiveCallCount = 0;
  let functionNames = new Set();
  let allocatedContainers = [];

  try {
    const ast = babelParser.parse(code, {
      sourceType: "unambiguous",
      plugins: ["typescript"],
      errorRecovery: true,
    });

    function traverse(node, parent) {
      if (!node || typeof node !== "object") return;

      // Track function definitions
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ClassMethod"
      ) {
        if (node.id?.name) functionNames.add(node.id.name);
        if (node.key?.name) functionNames.add(node.key.name);
      }

      // Track loop statements
      const isLoop =
        node.type === "ForStatement" ||
        node.type === "WhileStatement" ||
        node.type === "DoWhileStatement" ||
        node.type === "ForOfStatement" ||
        node.type === "ForInStatement";

      if (isLoop) {
        currentLoopDepth++;
        if (currentLoopDepth > maxLoopDepth) {
          maxLoopDepth = currentLoopDepth;
        }

        // Check for logarithmic step in for/while (e.g. i *= 2, i /= 2, i >>= 1)
        if (node.update) {
          const updateStr = code.slice(node.update.start, node.update.end);
          if (
            updateStr.includes("*=") ||
            updateStr.includes("/=") ||
            updateStr.includes(">>=") ||
            updateStr.includes("<<=")
          ) {
            hasLogarithmicStep = true;
          }
        }

        // Recursively inspect loop body
        for (const key of Object.keys(node)) {
          if (key !== "parent" && key !== "leadingComments") {
            const child = node[key];
            if (Array.isArray(child)) {
              for (const c of child) traverse(c, node);
            } else if (child && typeof child === "object") {
              traverse(child, node);
            }
          }
        }

        currentLoopDepth--;
        return;
      }

      // Check method calls
      if (node.type === "CallExpression") {
        const callee = node.callee;
        let calleeName = "";
        if (callee.type === "Identifier") calleeName = callee.name;
        else if (callee.type === "MemberExpression" && callee.property?.name) {
          calleeName = callee.property.name;
        }

        if (calleeName === "sort") hasSortingCall = true;

        if (functionNames.has(calleeName)) {
          recursiveCallCount++;
        }
      }

      // Check auxiliary container allocations
      if (node.type === "NewExpression" && node.callee?.name) {
        const name = node.callee.name;
        if (["Map", "Set", "Array"].includes(name)) {
          allocatedContainers.push(name);
        }
      } else if (node.type === "ArrayExpression" && node.elements.length > 2) {
        allocatedContainers.push("Array");
      }

      // Traverse children
      for (const key of Object.keys(node)) {
        if (key !== "parent" && key !== "leadingComments") {
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) traverse(c, node);
          } else if (child && typeof child === "object") {
            traverse(child, node);
          }
        }
      }
    }

    traverse(ast, null);
  } catch {
    // If Babel parsing fails on incomplete snippet, fallback to lexical analysis
    return analyzeLexicalStructure(code);
  }

  return {
    maxLoopDepth,
    hasLogarithmicStep,
    hasSortingCall,
    recursiveCallCount,
    allocatedContainers,
  };
}

/**
 * Structural & Lexical Analyzer for Python, C++, C, Java
 */
function analyzeLexicalStructure(code) {
  const lines = code.split("\n");
  let maxLoopDepth = 0;
  let currentLoopDepth = 0;
  let hasLogarithmicStep = false;
  let hasSortingCall = false;
  let recursiveCallCount = 0;
  let allocatedContainers = [];

  // Patterns
  const loopRegex = /\b(for|while)\b/;
  const logStepRegex = /(\*=|\/=|\/\/=|>>=|<<=|mid\s*=|binary_search)/;
  const sortRegex = /\b(sort|sorted|std::sort|Arrays\.sort|Collections\.sort|qsort)\b/;
  const recursionRegex = /\b(return\s+[a-zA-Z0-9_]+\s*\(|self\.[a-zA-Z0-9_]+\s*\()/;
  const containerAllocationRegex = /\b(unordered_map\s*<|map\s*<|unordered_set\s*<|set\s*<|vector\s*<[a-zA-Z0-9_]+>\s+[a-zA-Z0-9_]+\s*[;=(]|new\s+(HashMap|HashSet|ArrayList|Map|Set|[a-zA-Z0-9_]+\[)|malloc\s*\(|calloc\s*\(|[a-zA-Z0-9_]+\s*=\s*(\{\}|\[\]|dict\(\)|set\(\)|list\(\)))\b/;

  // Extract defined function names
  const definedFunctions = new Set();
  const fnDeclRegex = /\b(?:def|[a-zA-Z0-9_<>\*]+)\s+([a-zA-Z0-9_]+)\s*\(/g;
  let fnMatch;
  while ((fnMatch = fnDeclRegex.exec(code)) !== null) {
    if (!["if", "while", "for", "switch", "catch", "return", "main"].includes(fnMatch[1])) {
      definedFunctions.add(fnMatch[1]);
    }
  }

  // Global scan across lines for sorting, logarithmic step, containers, and recursion
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) continue;
    if (sortRegex.test(trimmed)) hasSortingCall = true;
    if (logStepRegex.test(trimmed)) hasLogarithmicStep = true;

    // Only count as auxiliary container if it's an allocation, not a pass-by-reference parameter
    const isParameterLine = (trimmed.includes("(") && trimmed.includes(")") && trimmed.includes("&")) || trimmed.startsWith("def ");
    if (!isParameterLine && containerAllocationRegex.test(trimmed)) {
      const match = trimmed.match(containerAllocationRegex);
      if (match) allocatedContainers.push(match[1]);
    }

    // Accurate count of recursive function calls
    for (const fn of definedFunctions) {
      const fnCallRegex = new RegExp(`\\b${fn}\\s*\\(`, "g");
      const occurrences = (trimmed.match(fnCallRegex) || []).length;
      if (occurrences > 0) {
        const isDecl =
          (trimmed.endsWith("{") || trimmed.endsWith(":")) &&
          (trimmed.startsWith(`def ${fn}`) ||
            new RegExp(`\\b(?:[a-zA-Z0-9_<>\*]+)\\s+${fn}\\s*\\(`).test(trimmed));
        const calls = isDecl ? Math.max(0, occurrences - 1) : occurrences;
        recursiveCallCount += calls;
      }
    }
  }

  // Check if language uses braces (C, C++, Java) or indentation (Python)
  const hasBraces = code.includes("{") && code.includes("}");

  if (!hasBraces) {
    // Python indentation-based loop tracking
    let indentStack = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      const indent = line.search(/\S/);
      while (indentStack.length > 0 && indent <= indentStack[indentStack.length - 1]) {
        indentStack.pop();
      }
      if (loopRegex.test(trimmed)) {
        indentStack.push(indent);
        if (indentStack.length > maxLoopDepth) maxLoopDepth = indentStack.length;
      }
    }
  } else {
    // Brace-based loop tracking for C++, C, Java
    let braceDepth = 0;
    let loopDepthsAtBraces = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        continue;
      }

      if (loopRegex.test(trimmed)) {
        currentLoopDepth++;
        if (currentLoopDepth > maxLoopDepth) maxLoopDepth = currentLoopDepth;
        loopDepthsAtBraces.push(braceDepth);
      }

      const openBraces = (trimmed.match(/\{/g) || []).length;
      const closeBraces = (trimmed.match(/\}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      while (loopDepthsAtBraces.length > 0 && braceDepth <= loopDepthsAtBraces[loopDepthsAtBraces.length - 1]) {
        loopDepthsAtBraces.pop();
        currentLoopDepth = Math.max(0, currentLoopDepth - 1);
      }
    }
  }

  return {
    maxLoopDepth,
    hasLogarithmicStep,
    hasSortingCall,
    recursiveCallCount,
    allocatedContainers,
  };
}

/**
 * Synthesizes static and empirical evidence into complexity estimates.
 */
function evaluateComplexityEvidence({ astResult, executionResult, language }) {
  const timeEvidence = [];
  const spaceEvidence = [];
  let timeEstimate = "Unknown";
  let timeConfidence = "low";
  let spaceEstimate = "Unknown";
  let spaceConfidence = "low";

  const {
    maxLoopDepth,
    hasLogarithmicStep,
    hasSortingCall,
    recursiveCallCount,
    allocatedContainers,
  } = astResult;

  // 1. Time Complexity Evaluation
  if (recursiveCallCount >= 2) {
    timeEstimate = "O(2^n)";
    timeConfidence = "medium";
    timeEvidence.push(`Multiple branching recursive invocations detected (${recursiveCallCount} calls)`);
  } else if (recursiveCallCount === 1) {
    if (hasLogarithmicStep) {
      timeEstimate = "O(log n)";
      timeConfidence = "high";
      timeEvidence.push("Divide-and-conquer logarithmic recursive recurrence detected");
    } else {
      timeEstimate = "O(n)";
      timeConfidence = "medium";
      timeEvidence.push("Single linear recursion branch detected");
    }
  } else if (maxLoopDepth >= 3) {
    timeEstimate = "O(n^3)";
    timeConfidence = "high";
    timeEvidence.push(`Nested loop depth of ${maxLoopDepth} detected`);
  } else if (maxLoopDepth === 2) {
    timeEstimate = "O(n^2)";
    timeConfidence = "high";
    timeEvidence.push("Two nested loops detected with dependent iteration bounds");
  } else if (maxLoopDepth === 1) {
    if (hasLogarithmicStep) {
      timeEstimate = "O(log n)";
      timeConfidence = "high";
      timeEvidence.push("Loop with logarithmic iteration step (binary search / divide)");
    } else if (hasSortingCall) {
      timeEstimate = "O(n log n)";
      timeConfidence = "high";
      timeEvidence.push("Single loop accompanied by O(n log n) sorting invocation");
    } else {
      timeEstimate = "O(n)";
      timeConfidence = "high";
      timeEvidence.push("Single loop with linear iteration step");
    }
  } else if (maxLoopDepth === 0) {
    if (hasSortingCall) {
      timeEstimate = "O(n log n)";
      timeConfidence = "high";
      timeEvidence.push("Direct standard sort algorithm invocation detected");
    } else {
      timeEstimate = "O(1)";
      timeConfidence = "high";
      timeEvidence.push("No iterative loops or recursion detected; constant time logic");
    }
  }

  // 2. Space Complexity Evaluation
  if (allocatedContainers.length > 0) {
    spaceEstimate = "O(n)";
    spaceConfidence = "high";
    spaceEvidence.push(
      `Auxiliary containers allocated: ${Array.from(new Set(allocatedContainers)).slice(0, 3).join(", ")}`,
    );
  } else if (recursiveCallCount > 0) {
    spaceEstimate = timeEstimate === "O(log n)" ? "O(log n)" : "O(n)";
    spaceConfidence = "medium";
    spaceEvidence.push(`Call stack memory required for recursion (${spaceEstimate})`);
  } else {
    spaceEstimate = "O(1)";
    spaceConfidence = "high";
    spaceEvidence.push("No dynamic auxiliary containers allocated; scalar variables only");
  }

  // 3. Empirical cross-referencing
  if (executionResult?.timeMs !== undefined) {
    timeEvidence.push(`Empirical execution time: ${executionResult.timeMs}ms`);
  }
  if (executionResult?.memoryKb !== undefined) {
    spaceEvidence.push(`Observed process peak memory: ${executionResult.memoryKb} KB`);
  }

  return {
    time: {
      bestEstimate: timeEstimate,
      confidence: timeConfidence,
      evidence: timeEvidence,
    },
    space: {
      bestEstimate: spaceEstimate,
      confidence: spaceConfidence,
      evidence: spaceEvidence,
    },
  };
}

/**
 * Public complexity analyzer service
 *
 * @param {object} params
 * @param {string} params.code - Student source code
 * @param {string} params.language - Programming language (cpp, python, javascript, etc.)
 * @param {string} [params.problemSlug] - Problem identifier
 * @param {object} [params.executionResult] - Optional runtime { timeMs, memoryKb }
 * @returns {object} Complexity evaluation result
 */
export async function analyzeComplexity({
  code,
  language,
  problemSlug = "",
  executionResult = null,
}) {
  if (!code || typeof code !== "string" || !code.trim()) {
    return {
      version: ANALYZER_VERSION,
      time: { bestEstimate: "Unknown", confidence: "unknown", evidence: ["No code provided"] },
      space: { bestEstimate: "Unknown", confidence: "unknown", evidence: ["No code provided"] },
      summary: "Complexity analysis unavailable",
    };
  }

  const cacheKey = getCacheKey(code, language, problemSlug);
  const cached = complexityCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const normLang = String(language || "").toLowerCase().trim();
  let astResult;

  if (normLang === "javascript" || normLang === "js") {
    astResult = analyzeJavaScriptAst(code);
  } else {
    astResult = analyzeLexicalStructure(code);
  }

  const evaluated = evaluateComplexityEvidence({
    astResult,
    executionResult,
    language: normLang,
  });

  const result = {
    version: ANALYZER_VERSION,
    time: evaluated.time,
    space: evaluated.space,
    summary: `Time: ${evaluated.time.bestEstimate}, Space: ${evaluated.space.bestEstimate} auxiliary`,
    analyzedAt: new Date().toISOString(),
  };

  if (complexityCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = complexityCache.keys().next().value;
    complexityCache.delete(oldestKey);
  }
  complexityCache.set(cacheKey, result);

  return result;
}
