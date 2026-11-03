import crypto from "crypto";
import * as babelParser from "@babel/parser";

export const ANALYZER_VERSION = "2.0.0";
const MAX_CACHE_ENTRIES = 500;
const complexityCache = new Map();

/**
 * Common data structure types and keywords that must NEVER be treated
 * as user function declarations or recursive call targets.
 */
const EXCLUDED_CONSTRUCTORS_AND_TYPES = new Set([
  "ListNode",
  "TreeNode",
  "Node",
  "Pair",
  "ListNode*",
  "TreeNode*",
  "Node*",
  "vector",
  "string",
  "unordered_map",
  "map",
  "unordered_set",
  "set",
  "queue",
  "deque",
  "stack",
  "priority_queue",
  "ArrayList",
  "HashMap",
  "HashSet",
  "LinkedList",
  "List",
  "Map",
  "Set",
  "Integer",
  "String",
  "Object",
  "Boolean",
  "Double",
  "int",
  "void",
  "bool",
  "boolean",
  "float",
  "double",
  "char",
  "long",
  "size_t",
  "auto",
  "const",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "return",
  "catch",
  "class",
  "struct",
  "public",
  "private",
  "protected",
  "main",
]);

/**
 * Computes a deterministic cache key for a submission analysis
 */
function getCacheKey(code, language, slug = "") {
  const normalized = String(code || "").trim().replace(/\r\n/g, "\n");
  return crypto
    .createHash("sha256")
    .update(`${language}:${slug}:${ANALYZER_VERSION}:${normalized}`)
    .digest("hex");
}

/**
 * Strips comments and string literals without disrupting newline counts.
 */
function stripCommentsAndStrings(code) {
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  const out = [];

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out.push(ch);
      } else {
        out.push(" ");
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        out.push("  ");
        i++;
      } else if (ch === "\n") {
        out.push("\n");
      } else {
        out.push(" ");
      }
      continue;
    }

    if (inString) {
      if (ch === "\\" && next) {
        out.push("  ");
        i++;
      } else if (ch === stringChar) {
        inString = false;
        out.push(" ");
      } else if (ch === "\n") {
        out.push("\n");
      } else {
        out.push(" ");
      }
      continue;
    }

    // Check for comment starts
    if (ch === "/" && next === "/") {
      inLineComment = true;
      out.push("  ");
      i++;
      continue;
    }
    if (ch === "#") {
      inLineComment = true;
      out.push(" ");
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      out.push("  ");
      i++;
      continue;
    }

    // Check for string starts
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      out.push(" ");
      continue;
    }

    out.push(ch);
  }

  return out.join("");
}

/**
 * JavaScript AST Analyzer using @babel/parser
 */
function analyzeJavaScriptAst(cleanSource, rawCode) {
  let maxLoopDepth = 0;
  let currentLoopDepth = 0;
  let sequentialLoopCount = 0;
  let hasLogarithmicStep = false;
  let hasSortingCall = false;
  let parallelMultiPointerTraversal = false;
  let hasIndependentDimensions = false;
  let isGraphBfs = false;
  let isGraphDfs = false;
  let isBacktracking = false;
  let isMemoized = false;
  let hasRecursiveDivideAndConquer = false;
  let hasMergeStep = false;

  let recursiveCallCount = 0;
  let primaryFunctionName = null;
  const functionNames = new Set();
  const auxiliaryContainers = [];
  let returnsConstructedOutput = false;
  let returnedStructureType = null;

  try {
    const ast = babelParser.parse(rawCode, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    });

    // 1. First pass: Collect legitimate function definitions
    function collectFunctions(node) {
      if (!node || typeof node !== "object") return;

      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ClassMethod"
      ) {
        const name = node.id?.name || node.key?.name;
        if (name && !EXCLUDED_CONSTRUCTORS_AND_TYPES.has(name)) {
          functionNames.add(name);
          if (!primaryFunctionName) primaryFunctionName = name;
        }
      }

      if (node.type === "VariableDeclarator" && node.id?.name) {
        if (
          node.init?.type === "ArrowFunctionExpression" ||
          node.init?.type === "FunctionExpression"
        ) {
          const name = node.id.name;
          if (!EXCLUDED_CONSTRUCTORS_AND_TYPES.has(name)) {
            functionNames.add(name);
            if (!primaryFunctionName) primaryFunctionName = name;
          }
        }
      }

      for (const key of Object.keys(node)) {
        if (key !== "parent" && key !== "leadingComments") {
          const child = node[key];
          if (Array.isArray(child)) {
            for (const c of child) collectFunctions(c);
          } else if (child && typeof child === "object") {
            collectFunctions(child);
          }
        }
      }
    }
    collectFunctions(ast);

    // 2. Second pass: Detailed structural inspection
    function traverse(node, parent) {
      if (!node || typeof node !== "object") return;

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
        if (currentLoopDepth === 1) {
          sequentialLoopCount++;
        }

        // Inspect while condition for parallel traversal (e.g. l1 || l2 || carry)
        if (node.test) {
          const testCode = rawCode.slice(node.test.start, node.test.end);
          if (
            testCode.includes("||") &&
            (testCode.includes("l1") ||
              testCode.includes("l2") ||
              testCode.includes("head") ||
              testCode.includes("curr") ||
              testCode.includes("carry"))
          ) {
            parallelMultiPointerTraversal = true;
          }
        }

        // Check for logarithmic step in for/while (e.g. i *= 2, i /= 2, i >>= 1)
        if (node.update) {
          const updateStr = rawCode.slice(node.update.start, node.update.end);
          if (
            updateStr.includes("*=") ||
            updateStr.includes("/=") ||
            updateStr.includes(">>=") ||
            updateStr.includes("<<=")
          ) {
            hasLogarithmicStep = true;
          }
        }

        // Check loop body
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

      // Check method/function calls
      if (node.type === "CallExpression") {
        const callee = node.callee;
        let calleeName = "";
        if (callee.type === "Identifier") calleeName = callee.name;
        else if (callee.type === "MemberExpression" && callee.property?.name) {
          calleeName = callee.property.name;
        }

        if (calleeName === "sort") hasSortingCall = true;

        // Recursive invocation check
        if (primaryFunctionName && calleeName === primaryFunctionName) {
          recursiveCallCount++;
        } else if (functionNames.has(calleeName)) {
          recursiveCallCount++;
        }

        // Check for memoization lookup / storage
        if (
          calleeName === "has" ||
          calleeName === "get" ||
          calleeName === "set"
        ) {
          const objName = callee.object?.name || "";
          if (
            objName.includes("memo") ||
            objName.includes("dp") ||
            objName.includes("cache")
          ) {
            isMemoized = true;
          }
        }
      }

      // Check return statement to detect returned constructed structures
      if (node.type === "ReturnStatement" && node.argument) {
        const retCode = rawCode.slice(node.argument.start, node.argument.end);
        if (
          retCode.includes("dummy.next") ||
          retCode.includes("head") ||
          retCode.includes("new ")
        ) {
          returnsConstructedOutput = true;
          returnedStructureType = "ListNode";
        }
      }

      // Check allocations
      if (node.type === "NewExpression" && node.callee?.name) {
        const name = node.callee.name;
        if (["Map", "Set"].includes(name)) {
          auxiliaryContainers.push(name);
        } else if (name === "Array") {
          auxiliaryContainers.push("Array");
        } else if (name === "ListNode" || name === "TreeNode") {
          // If returned as output, this belongs to Output Space
          if (returnsConstructedOutput || rawCode.includes("dummy.next")) {
            returnsConstructedOutput = true;
            returnedStructureType = name;
          } else {
            auxiliaryContainers.push(name);
          }
        }
      } else if (node.type === "ArrayExpression" && node.elements.length > 2) {
        auxiliaryContainers.push("Array");
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
    // If Babel parsing fails on an unusual snippet, fall back to structural lexical analysis
    return analyzeStructuralTokens(cleanSource, rawCode, "javascript");
  }

  // Cross-check for binary search patterns inside code
  if (
    cleanSource.includes("Math.floor((l + r) / 2)") ||
    cleanSource.includes("Math.floor((low + high) / 2)") ||
    cleanSource.includes("(l + r) >> 1") ||
    cleanSource.includes("l + Math.floor((r - l) / 2)")
  ) {
    hasLogarithmicStep = true;
  }

  // Check memoization in clean source
  if (
    cleanSource.includes("memo[") ||
    cleanSource.includes("dp[") ||
    cleanSource.includes("cache[")
  ) {
    isMemoized = true;
  }

  return {
    maxLoopDepth,
    sequentialLoopCount,
    hasLogarithmicStep,
    hasSortingCall,
    parallelMultiPointerTraversal,
    hasIndependentDimensions,
    isGraphBfs,
    isGraphDfs,
    isBacktracking,
    isMemoized,
    hasRecursiveDivideAndConquer,
    hasMergeStep,
    recursiveCallCount,
    primaryFunctionName,
    auxiliaryContainers,
    returnsConstructedOutput,
    returnedStructureType,
  };
}

/**
 * Structural Token Analyzer for Python, C++, Java, C, and fallback JavaScript.
 */
function analyzeStructuralTokens(cleanSource, rawCode, language) {
  const lines = cleanSource.split("\n");
  let maxLoopDepth = 0;
  let currentLoopDepth = 0;
  let sequentialLoopCount = 0;
  let hasLogarithmicStep = false;
  let hasSortingCall = false;
  let parallelMultiPointerTraversal = false;
  let hasIndependentDimensions = false;
  let isGraphBfs = false;
  let isGraphDfs = false;
  let isBacktracking = false;
  let isMemoized = false;
  let hasRecursiveDivideAndConquer = false;
  let hasMergeStep = false;

  let recursiveCallCount = 0;
  let primaryFunctionName = null;
  const auxiliaryContainers = [];
  let returnsConstructedOutput = false;
  let returnedStructureType = null;

  // 1. Identify legitimate primary function declarations
  // Exclude constructors like `ListNode dummy(0);` or `new ListNode`
  const definedFunctions = new Set();
  const fnDeclRegex =
    /\b(?:def|(?:[a-zA-Z0-9_<>\*]+))\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g;
  let fnMatch;
  while ((fnMatch = fnDeclRegex.exec(cleanSource)) !== null) {
    const fnName = fnMatch[1];
    if (
      !EXCLUDED_CONSTRUCTORS_AND_TYPES.has(fnName) &&
      !["new", "delete", "sizeof", "typeof", "instanceof"].includes(fnName)
    ) {
      definedFunctions.add(fnName);
      if (!primaryFunctionName) {
        primaryFunctionName = fnName;
      }
    }
  }

  // Check return signature / structure
  if (
    cleanSource.includes("ListNode*") ||
    cleanSource.includes("ListNode") ||
    cleanSource.includes("dummy.next") ||
    cleanSource.includes("dummy->next")
  ) {
    if (
      cleanSource.includes("new ListNode") ||
      cleanSource.includes("ListNode(")
    ) {
      returnsConstructedOutput = true;
      returnedStructureType = "ListNode";
    }
  }

  // Check for parallel multi-pointer traversal
  const parallelTraversalRegex =
    /\bwhile\s*\(\s*(?:l1\s*\|\|\s*l2|headA\s*\|\|\s*headB|p1\s*\|\|\s*p2|curr1\s*\|\|\s*curr2|l1\s+or\s+l2)\b/i;
  if (
    parallelTraversalRegex.test(cleanSource) ||
    cleanSource.includes("l1 || l2 || carry") ||
    cleanSource.includes("l1 or l2 or carry")
  ) {
    parallelMultiPointerTraversal = true;
  }

  // Check for logarithmic steps (binary search)
  const logStepRegex =
    /(\*=|\/=|\/\/=|>>=|<<=|mid\s*=|mid\s*\/\/=|binary_search|std::lower_bound|std::upper_bound)/;
  if (
    logStepRegex.test(cleanSource) ||
    cleanSource.includes("(l + r) / 2") ||
    cleanSource.includes("(low + high) / 2") ||
    cleanSource.includes("l + (r - l) / 2") ||
    cleanSource.includes("low + (high - low) / 2")
  ) {
    hasLogarithmicStep = true;
  }

  // Check for sorting
  const sortRegex =
    /\b(sort|sorted|std::sort|Arrays\.sort|Collections\.sort|qsort)\b/;
  if (sortRegex.test(cleanSource)) {
    hasSortingCall = true;
  }

  // Check for memoization
  if (
    cleanSource.includes("memo[") ||
    cleanSource.includes("dp[") ||
    cleanSource.includes("cache[") ||
    cleanSource.includes("@lru_cache") ||
    cleanSource.includes("@cache") ||
    cleanSource.includes("memo.count") ||
    cleanSource.includes("memo.find") ||
    cleanSource.includes("memo.containsKey") ||
    cleanSource.includes("memo.has")
  ) {
    isMemoized = true;
  }

  // Check for Graph BFS / DFS patterns
  if (
    (cleanSource.includes("queue<") ||
      cleanSource.includes("Queue<") ||
      cleanSource.includes("deque") ||
      cleanSource.includes("ArrayDeque") ||
      cleanSource.includes("collections.deque")) &&
    (cleanSource.includes("visited") || cleanSource.includes("seen"))
  ) {
    isGraphBfs = true;
  } else if (
    (cleanSource.includes("dfs(") || cleanSource.includes("DFS(")) &&
    (cleanSource.includes("visited") || cleanSource.includes("graph"))
  ) {
    isGraphDfs = true;
  }

  // Check for backtracking
  if (
    cleanSource.includes("backtrack(") ||
    cleanSource.includes("generateSubsets") ||
    cleanSource.includes("subsets(")
  ) {
    isBacktracking = true;
  }

  // Check for Merge Sort
  if (
    cleanSource.includes("merge(") &&
    (cleanSource.includes("mergeSort") || cleanSource.includes("mergesort"))
  ) {
    hasRecursiveDivideAndConquer = true;
    hasMergeStep = true;
  }

  // Check for auxiliary container allocations
  // Note: Ignore `ListNode` / `TreeNode` if it is returned as output
  const containerAllocationRegex =
    /\b(unordered_map\s*<|map\s*<|unordered_set\s*<|set\s*<|new\s+HashMap|new\s+HashSet|new\s+ArrayList|new\s+Map|new\s+Set|dict\(|set\(|\bseen\s*=\s*\{\}|\bseen\s*=\s*set\(\))\b/;
  if (containerAllocationRegex.test(cleanSource)) {
    const match = cleanSource.match(containerAllocationRegex);
    if (match) auxiliaryContainers.push(match[1]);
  }

  // Auxiliary vector/array check (ensure it is not the parameter signature)
  const auxVectorRegex =
    /\b(?:vector<[a-zA-Z0-9_]+>\s+([a-zA-Z0-9_]+)\s*(?:;|=)|int\s+[a-zA-Z0-9_]+\[[a-zA-Z0-9_+ -]+\])/g;
  let vMatch;
  while ((vMatch = auxVectorRegex.exec(cleanSource)) !== null) {
    if (
      !cleanSource.slice(0, vMatch.index).endsWith("return ") &&
      !cleanSource.slice(vMatch.index, vMatch.index + 50).includes("return dummy")
    ) {
      auxiliaryContainers.push("vector/array");
      break;
    }
  }

  // Loop depth and nesting tracking
  const loopKeywordRegex = /\b(for|while)\b/;
  const hasBraces = cleanSource.includes("{") && cleanSource.includes("}");

  if (!hasBraces) {
    // Python indentation-based loop tracking
    let indentStack = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.search(/\S/);

      while (
        indentStack.length > 0 &&
        indent <= indentStack[indentStack.length - 1]
      ) {
        indentStack.pop();
      }

      if (loopKeywordRegex.test(trimmed) && trimmed.endsWith(":")) {
        indentStack.push(indent);
        if (indentStack.length > maxLoopDepth) {
          maxLoopDepth = indentStack.length;
        }
        if (indentStack.length === 1) {
          sequentialLoopCount++;
        }
      }
    }
  } else {
    // Brace-based loop tracking (C++, Java, C, JS)
    let braceDepth = 0;
    const loopDepthsAtBraces = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*"))
        continue;

      if (loopKeywordRegex.test(trimmed)) {
        currentLoopDepth++;
        if (currentLoopDepth > maxLoopDepth) {
          maxLoopDepth = currentLoopDepth;
        }
        if (currentLoopDepth === 1) {
          sequentialLoopCount++;
        }
        loopDepthsAtBraces.push(braceDepth);
      }

      const openBraces = (trimmed.match(/\{/g) || []).length;
      const closeBraces = (trimmed.match(/\}/g) || []).length;
      braceDepth += openBraces - closeBraces;

      while (
        loopDepthsAtBraces.length > 0 &&
        braceDepth <= loopDepthsAtBraces[loopDepthsAtBraces.length - 1]
      ) {
        loopDepthsAtBraces.pop();
        currentLoopDepth = Math.max(0, currentLoopDepth - 1);
      }
    }
  }

  // Nested independent dimensions check: outer loop over n, inner loop over m
  if (maxLoopDepth === 2) {
    const loopMatches = [
      ...cleanSource.matchAll(
        /\b(?:for|while)\s*(?:\([^)]*\)|[^\r\n:{]+:)/g,
      ),
    ];
    if (loopMatches.length >= 2) {
      const outerText = loopMatches[0][0];
      const innerText = loopMatches[1][0];
      const hasN =
        /\b(?:n|nums1|arr1|a|rows|height)\b/.test(outerText) ||
        outerText.includes("len(a)");
      const hasM =
        /\b(?:m|nums2|arr2|b|cols|width)\b/.test(innerText) ||
        innerText.includes("len(b)");
      if (hasN && hasM) {
        hasIndependentDimensions = true;
      }
    }
  }

  // Count recursive function calls: function calling itself by name
  if (primaryFunctionName) {
    // Escape for regex
    const escapedFn = primaryFunctionName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    // Find all calls like `fnName(` or `self.fnName(`
    const fnCallRegex = new RegExp(`(?:self\\.)?\\b${escapedFn}\\s*\\(`, "g");
    const allMatches = cleanSource.match(fnCallRegex) || [];
    // Subtract 1 for the definition itself
    recursiveCallCount = Math.max(0, allMatches.length - 1);
  }

  return {
    maxLoopDepth,
    sequentialLoopCount,
    hasLogarithmicStep,
    hasSortingCall,
    parallelMultiPointerTraversal,
    hasIndependentDimensions,
    isGraphBfs,
    isGraphDfs,
    isBacktracking,
    isMemoized,
    hasRecursiveDivideAndConquer,
    hasMergeStep,
    recursiveCallCount,
    primaryFunctionName,
    auxiliaryContainers,
    returnsConstructedOutput,
    returnedStructureType,
  };
}

/**
 * Synthesizes structural metrics into rigorous Time & Space complexity classifications.
 */
function evaluateComplexityEvidence({ astResult, executionResult, language }) {
  const timeEvidence = [];
  const spaceEvidence = [];
  const detectedPatterns = [];
  const assumptions = [];
  const limitations = [];

  let timeEstimate = "O(1)";
  let timeConfidence = "high";

  let auxiliarySpaceEstimate = "O(1)";
  let outputSpaceEstimate = "O(1)";
  let totalSpaceEstimate = "O(1)";
  let spaceConfidence = "high";

  const {
    maxLoopDepth,
    sequentialLoopCount,
    hasLogarithmicStep,
    hasSortingCall,
    parallelMultiPointerTraversal,
    hasIndependentDimensions,
    isGraphBfs,
    isGraphDfs,
    isBacktracking,
    isMemoized,
    hasRecursiveDivideAndConquer,
    hasMergeStep,
    recursiveCallCount,
    primaryFunctionName,
    auxiliaryContainers,
    returnsConstructedOutput,
    returnedStructureType,
  } = astResult;

  // -------------------------------------------------------------
  // 1. TIME COMPLEXITY SYNTHESIS
  // -------------------------------------------------------------
  if (isGraphBfs) {
    timeEstimate = "O(V + E)";
    timeConfidence = "high";
    timeEvidence.push("Breadth-First Search (BFS) graph traversal detected");
    timeEvidence.push("Visits each vertex and traverses each edge at most once");
    detectedPatterns.push("breadth_first_search");
  } else if (isGraphDfs) {
    timeEstimate = "O(V + E)";
    timeConfidence = "high";
    timeEvidence.push("Depth-First Search (DFS) graph traversal detected");
    timeEvidence.push("Visits each vertex and traverses each edge at most once");
    detectedPatterns.push("depth_first_search");
  } else if (isBacktracking || (recursiveCallCount >= 2 && !isMemoized)) {
    timeEstimate = "O(2^n)";
    timeConfidence = "high";
    timeEvidence.push(
      `Branching recursion detected without memoization (${recursiveCallCount} recursive invocations per state)`,
    );
    detectedPatterns.push("branching_recursion");
  } else if (recursiveCallCount >= 2 && isMemoized) {
    timeEstimate = "O(n)";
    timeConfidence = "high";
    timeEvidence.push(
      "Branching recursion with dynamic programming / memoization cache detected",
    );
    timeEvidence.push(
      "Each unique subproblem state is evaluated at most once",
    );
    detectedPatterns.push("memoized_dynamic_programming");
  } else if (hasRecursiveDivideAndConquer && hasMergeStep) {
    timeEstimate = "O(n log n)";
    timeConfidence = "high";
    timeEvidence.push(
      "Divide-and-conquer recurrence with linear merge step detected (Merge Sort)",
    );
    detectedPatterns.push("divide_and_conquer");
  } else if (recursiveCallCount === 1) {
    if (hasLogarithmicStep) {
      timeEstimate = "O(log n)";
      timeConfidence = "high";
      timeEvidence.push("Single branch divide-and-conquer logarithmic recurrence");
      detectedPatterns.push("binary_search_recursion");
    } else {
      timeEstimate = "O(n)";
      timeConfidence = "high";
      timeEvidence.push(
        "Single linear recursive descent detected with step decrement",
      );
      detectedPatterns.push("linear_recursion");
    }
  } else if (parallelMultiPointerTraversal) {
    timeEstimate = "O(max(n, m))";
    timeConfidence = "high";
    timeEvidence.push(
      "Single while-loop traversing multiple linked-list / pointer inputs until all are exhausted",
    );
    timeEvidence.push(
      "Independent conditional branches evaluated in constant O(1) time per step",
    );
    detectedPatterns.push("parallel_linked_list_traversal");
  } else if (maxLoopDepth >= 3) {
    timeEstimate = `O(n^${maxLoopDepth})`;
    timeConfidence = "high";
    timeEvidence.push(`Nested loop depth of ${maxLoopDepth} detected`);
    detectedPatterns.push("multi_nested_loops");
  } else if (maxLoopDepth === 2) {
    if (hasIndependentDimensions) {
      timeEstimate = "O(n × m)";
      timeConfidence = "high";
      timeEvidence.push(
        "Two nested loops iterating over independent input dimensions (n and m)",
      );
      detectedPatterns.push("nested_independent_loops");
    } else {
      timeEstimate = "O(n^2)";
      timeConfidence = "high";
      timeEvidence.push(
        "Two nested loops with dependent iteration bounds detected",
      );
      detectedPatterns.push("nested_loops");
    }
  } else if (maxLoopDepth === 1) {
    if (hasLogarithmicStep) {
      timeEstimate = "O(log n)";
      timeConfidence = "high";
      timeEvidence.push(
        "Loop with logarithmic halving/doubling step detected (Binary Search)",
      );
      detectedPatterns.push("binary_search");
    } else if (hasSortingCall) {
      timeEstimate = "O(n log n)";
      timeConfidence = "high";
      timeEvidence.push(
        "Linear loop preceded or accompanied by O(n log n) sorting algorithm",
      );
      detectedPatterns.push("sorting_with_linear_pass");
    } else if (sequentialLoopCount >= 2 && hasIndependentDimensions) {
      timeEstimate = "O(n + m)";
      timeConfidence = "high";
      timeEvidence.push(
        "Sequential independent loops traversing dimension n followed by dimension m",
      );
      detectedPatterns.push("sequential_independent_loops");
    } else {
      timeEstimate = "O(n)";
      timeConfidence = "high";
      timeEvidence.push(
        sequentialLoopCount > 1
          ? `${sequentialLoopCount} sequential loops each with linear iteration bounds`
          : "Single loop with linear iteration step",
      );
      detectedPatterns.push("linear_traversal");
    }
  } else if (maxLoopDepth === 0) {
    if (hasSortingCall) {
      timeEstimate = "O(n log n)";
      timeConfidence = "high";
      timeEvidence.push(
        "Standard library comparison sort invocation detected",
      );
      detectedPatterns.push("standard_sort");
    } else {
      timeEstimate = "O(1)";
      timeConfidence = "high";
      timeEvidence.push(
        "No iterative loops or recursion detected; straight-line constant-time execution",
      );
      detectedPatterns.push("constant_time_operations");
    }
  }

  // -------------------------------------------------------------
  // 2. SPACE COMPLEXITY SYNTHESIS (Auxiliary vs Output vs Total)
  // -------------------------------------------------------------

  // A. Output Space
  if (returnsConstructedOutput) {
    if (parallelMultiPointerTraversal) {
      outputSpaceEstimate = "O(max(n, m))";
      spaceEvidence.push(
        "Output space is O(max(n, m)) for newly allocated result ListNode sequence returned to caller",
      );
    } else {
      outputSpaceEstimate = "O(n)";
      spaceEvidence.push(
        "Output space is O(n) for returned newly constructed data structure",
      );
    }
  } else {
    outputSpaceEstimate = "O(1)";
  }

  // B. Auxiliary Space
  if (isGraphBfs) {
    auxiliarySpaceEstimate = "O(V)";
    spaceConfidence = "high";
    spaceEvidence.push(
      "Auxiliary queue and visited vertex tracking require O(V) space",
    );
  } else if (isGraphDfs) {
    auxiliarySpaceEstimate = "O(V)";
    spaceConfidence = "high";
    spaceEvidence.push(
      "Auxiliary call stack / visited tracking requires O(V) space",
    );
  } else if (auxiliaryContainers.length > 0) {
    auxiliarySpaceEstimate = "O(n)";
    spaceConfidence = "high";
    spaceEvidence.push(
      `Auxiliary dynamic container(s) allocated: ${Array.from(new Set(auxiliaryContainers)).slice(0, 3).join(", ")}`,
    );
  } else if (isMemoized) {
    auxiliarySpaceEstimate = "O(n)";
    spaceConfidence = "high";
    spaceEvidence.push(
      "Auxiliary memoization cache table stores subproblem results (O(n) space)",
    );
  } else if (recursiveCallCount > 0) {
    if (hasRecursiveDivideAndConquer && hasMergeStep) {
      auxiliarySpaceEstimate = "O(n)";
      spaceConfidence = "high";
      spaceEvidence.push(
        "Auxiliary merge step in divide-and-conquer requires O(n) temporary buffer space",
      );
    } else if (hasLogarithmicStep || timeEstimate === "O(log n)") {
      auxiliarySpaceEstimate = "O(log n)";
      spaceConfidence = "high";
      spaceEvidence.push(
        "Auxiliary call stack depth bounded logarithmically by divide-and-conquer steps",
      );
    } else {
      auxiliarySpaceEstimate = "O(n)";
      spaceConfidence = "high";
      spaceEvidence.push(
        "Auxiliary call stack memory proportional to recursion depth (O(n))",
      );
    }
  } else {
    auxiliarySpaceEstimate = "O(1)";
    spaceConfidence = "high";
    spaceEvidence.push(
      "Auxiliary space is O(1); only scalar variables, pointers, and counters maintained",
    );
  }

  // C. Total Space (Auxiliary + Output)
  if (auxiliarySpaceEstimate === "O(1)" && outputSpaceEstimate === "O(1)") {
    totalSpaceEstimate = "O(1)";
  } else if (
    auxiliarySpaceEstimate === "O(1)" &&
    outputSpaceEstimate === "O(max(n, m))"
  ) {
    totalSpaceEstimate = "O(max(n, m))";
  } else if (
    auxiliarySpaceEstimate === "O(1)" &&
    outputSpaceEstimate === "O(n)"
  ) {
    totalSpaceEstimate = "O(n)";
  } else if (
    auxiliarySpaceEstimate === "O(n)" ||
    outputSpaceEstimate === "O(n)"
  ) {
    totalSpaceEstimate = "O(n)";
  } else if (auxiliarySpaceEstimate === "O(V)") {
    totalSpaceEstimate = "O(V)";
  } else {
    totalSpaceEstimate = auxiliarySpaceEstimate;
  }

  // Empirical metrics notes (preserved for telemetry, never overriding asymptotic class)
  if (executionResult?.timeMs !== undefined) {
    timeEvidence.push(
      `Empirical Judge0 runtime observation: ${executionResult.timeMs}ms (benchmark only; does not alter asymptotic derivation)`,
    );
  }
  if (executionResult?.memoryKb !== undefined) {
    spaceEvidence.push(
      `Empirical peak process memory: ${executionResult.memoryKb} KB (benchmark only)`,
    );
  }

  return {
    time: {
      bestEstimate: timeEstimate,
      confidence: timeConfidence,
      evidence: timeEvidence,
    },
    space: {
      bestEstimate: auxiliarySpaceEstimate,
      auxiliary: auxiliarySpaceEstimate,
      output: outputSpaceEstimate,
      total: totalSpaceEstimate,
      confidence: spaceConfidence,
      evidence: spaceEvidence,
    },
    timeComplexity: {
      value: timeEstimate,
      confidence: timeConfidence,
      reasoning: timeEvidence,
    },
    spaceComplexity: {
      auxiliary: auxiliarySpaceEstimate,
      output: outputSpaceEstimate,
      total: totalSpaceEstimate,
      confidence: spaceConfidence,
      reasoning: spaceEvidence,
    },
    detectedPatterns,
    assumptions,
    limitations,
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
      time: {
        bestEstimate: "Unknown",
        confidence: "unknown",
        evidence: ["No code provided"],
      },
      space: {
        bestEstimate: "Unknown",
        confidence: "unknown",
        evidence: ["No code provided"],
      },
      timeComplexity: {
        value: "Unknown",
        confidence: "unknown",
        reasoning: ["No code provided"],
      },
      spaceComplexity: {
        auxiliary: "Unknown",
        output: "Unknown",
        total: "Unknown",
        confidence: "unknown",
        reasoning: ["No code provided"],
      },
      summary: "Complexity analysis unavailable",
      analysisStatus: "unknown",
      assumptions: [],
      limitations: ["Source code was empty or whitespace only"],
    };
  }

  const cacheKey = getCacheKey(code, language, problemSlug);
  const cached = complexityCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const normLang = String(language || "")
    .toLowerCase()
    .trim();
  const cleanSource = stripCommentsAndStrings(code);

  let astResult;
  try {
    if (normLang === "javascript" || normLang === "js") {
      astResult = analyzeJavaScriptAst(cleanSource, code);
    } else {
      astResult = analyzeStructuralTokens(cleanSource, code, normLang);
    }
  } catch (err) {
    return {
      version: ANALYZER_VERSION,
      time: {
        bestEstimate: "Unknown",
        confidence: "low",
        evidence: [`Parsing error encountered: ${err.message}`],
      },
      space: {
        bestEstimate: "Unknown",
        confidence: "low",
        evidence: [`Parsing error encountered: ${err.message}`],
      },
      timeComplexity: {
        value: "Unknown",
        confidence: "low",
        reasoning: [`Parsing error encountered: ${err.message}`],
      },
      spaceComplexity: {
        auxiliary: "Unknown",
        output: "Unknown",
        total: "Unknown",
        confidence: "low",
        reasoning: [`Parsing error encountered: ${err.message}`],
      },
      summary: "Complexity analysis could not parse input",
      analysisStatus: "unknown",
      assumptions: [],
      limitations: ["Source code syntax could not be resolved into AST"],
    };
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
    timeComplexity: evaluated.timeComplexity,
    spaceComplexity: evaluated.spaceComplexity,
    summary: `Time: ${evaluated.time.bestEstimate}, Space: ${evaluated.space.auxiliary} auxiliary, ${evaluated.space.output} output (${evaluated.space.total} total)`,
    analysisStatus: "completed",
    detectedPatterns: evaluated.detectedPatterns,
    assumptions: evaluated.assumptions,
    limitations: evaluated.limitations,
    analyzedAt: new Date().toISOString(),
  };

  if (complexityCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = complexityCache.keys().next().value;
    complexityCache.delete(oldestKey);
  }
  complexityCache.set(cacheKey, result);

  return result;
}
