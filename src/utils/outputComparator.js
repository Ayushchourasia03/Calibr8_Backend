/**
 * Calibr8 Output Normalization and Comparison Utilities
 *
 * Compares program output against expected testcase output, handling
 * whitespace, JSON arrays/objects, space- or comma-separated number lists and
 * case-insensitive true/false.
 *
 * Numbers are compared by their exact value: integers are canonicalized as
 * arbitrary-precision decimals (so 64-bit answers that differ in the last
 * digit are never equal, which plain JavaScript numbers cannot guarantee),
 * other numbers by their double value ("0.10" equals "0.1").
 *
 * Deliberately kept lenient: a single-element array equals its element
 * ("[0]" vs "0"), because the language drivers print one-element lists as a
 * bare value. Deliberately strict: "yes"/"no" are NOT booleans.
 */

import { readLimit } from "../config/limits.js";

const NUMBER_TAG = "\u0000n:";

// SECURITY (SA-H1): every pattern below is linear-time. Program output is
// attacker-controlled and is compared on the main event loop, so no pattern
// may contain quantifiers that can split the same characters in more than one
// way (the previous `\d+\.?\d*` took O(n^2) on a long digit run ending in a
// non-digit: ~8 s for 64 KB). The fraction is only reachable after a literal
// "." here, so a digit run can be matched in exactly one way.
const INTEGER_LEXEME = /^[+-]?\d+$/;
const DECIMAL_LEXEME = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Program output longer than this (or than twice the expected output, if
 * that is larger) is never compared: the caller reports Output Limit
 * Exceeded. CodeBox truncates outputs at 65,536 characters and appends a
 * marker, so a truncated output always exceeds the default.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 65_536;

export function maxComparableOutputChars(expectedRaw, limit = configuredOutputLimit()) {
  const expectedLength = typeof expectedRaw === "string" ? expectedRaw.length : 0;
  return Math.max(limit, expectedLength * 2 + 1024);
}

function configuredOutputLimit() {
  return readLimit("JUDGE_MAX_OUTPUT_CHARS");
}

/** True when the program output is too large to be compared (see above). */
export function exceedsOutputLimit(actualRaw, expectedRaw) {
  const length = typeof actualRaw === "string" ? actualRaw.length : String(actualRaw ?? "").length;
  return length > maxComparableOutputChars(expectedRaw);
}

/**
 * Canonical integer text, identical to BigInt(text).toString() but linear in
 * the length (no big-number arithmetic on attacker-sized input).
 */
function canonicalInteger(text) {
  let index = 0;
  let negative = false;
  if (text[0] === "+" || text[0] === "-") {
    negative = text[0] === "-";
    index = 1;
  }
  while (index < text.length - 1 && text[index] === "0") index++;
  const digits = text.slice(index);
  return digits === "0" ? "0" : `${negative ? "-" : ""}${digits}`;
}

/** Canonical form of a numeric lexeme, or null when it is not a number. */
function canonicalNumber(lexeme) {
  const text = String(lexeme).trim();
  if (INTEGER_LEXEME.test(text)) return canonicalInteger(text);
  if (!DECIMAL_LEXEME.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // Non-integer lexemes compare by double value; integral ones ("1e3",
  // "5.0") therefore equal the integer they denote.
  return String(value);
}

const tagNumber = (canonical) => `${NUMBER_TAG}${canonical}`;

// Strict JSON number grammar (RFC 8259), unambiguous and linear-time.
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const isNumberChar = (code) =>
  (code >= 48 && code <= 57) || code === 45 || code === 43 || code === 46 || code === 101 || code === 69;

/**
 * JSON.parse that keeps exact numeric values: every number becomes a tagged
 * canonical string, built from its source text (no precision loss).
 *
 * One linear pass replaces each number token outside strings by its tagged
 * string, then the native parser runs without a reviver (a reviver with
 * source-text access cost ~100 ms for a 64 KB array, SA-H1). Tokens that are
 * not valid JSON numbers throw, exactly like JSON.parse did before.
 */
function parseExactJson(text) {
  const parts = [];
  let chunkStart = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      // String literal: copied as is (escapes skipped, never tagged).
      i++;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 92) {
          i += 2;
          continue;
        }
        i++;
        if (c === 34) break;
      }
      continue;
    }
    if (code === 45 || (code >= 48 && code <= 57)) {
      let j = i + 1;
      while (j < n && isNumberChar(text.charCodeAt(j))) j++;
      const lexeme = text.slice(i, j);
      if (!JSON_NUMBER.test(lexeme)) throw new SyntaxError("Invalid JSON number");
      parts.push(text.slice(chunkStart, i), JSON.stringify(tagNumber(canonicalNumber(lexeme))));
      chunkStart = j;
      i = j;
      continue;
    }
    i++;
  }
  parts.push(text.slice(chunkStart));
  return JSON.parse(parts.join(""));
}

const isTaggedNumber = (value) => typeof value === "string" && value.startsWith(NUMBER_TAG);
const untag = (value) => (isTaggedNumber(value) ? value.slice(NUMBER_TAG.length) : value);

/**
 * Normalizes values for comparison.
 *
 * @param {*} val - Raw output string or object
 * @returns {string} Normalized string representation
 */
export function normalizeOutput(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number" || typeof val === "bigint") {
    return canonicalNumber(String(val)) ?? String(val);
  }

  const clean = String(val).trim();
  if (!clean) return "";

  // Case-insensitive booleans (Python prints True/False).
  const lower = clean.toLowerCase();
  if (lower === "true" || lower === "false") return lower;

  // A single number.
  const single = canonicalNumber(clean);
  if (single !== null) return single;

  // JSON arrays / objects / strings with exact numbers.
  if (/^[[{"]/.test(clean)) {
    try {
      const parsed = parseExactJson(clean);
      if (typeof parsed === "boolean") return parsed ? "true" : "false";
      if (isTaggedNumber(parsed)) return untag(parsed);
      return JSON.stringify(parsed);
    } catch {
      // Not valid JSON.
    }
  }

  // Space-separated numbers (e.g. "7 0 8").
  const spaceParts = clean.split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1) {
    const numbers = spaceParts.map(canonicalNumber);
    if (numbers.every((n) => n !== null)) return JSON.stringify(numbers.map(tagNumber));
  }

  // Comma-separated numbers without brackets (e.g. "7, 0, 8").
  const commaParts = clean.split(",").map((s) => s.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    const numbers = commaParts.map(canonicalNumber);
    if (numbers.every((n) => n !== null)) return JSON.stringify(numbers.map(tagNumber));
  }

  return clean;
}

/** Re-reads a normalized value as a structure (tagged numbers), or undefined. */
function structureOf(normalized) {
  if (canonicalNumber(normalized) !== null) return tagNumber(canonicalNumber(normalized));
  if (normalized === "true" || normalized === "false") return normalized === "true";
  if (/^[[{"]/.test(normalized)) {
    try {
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scalarText(value) {
  if (isTaggedNumber(value)) return untag(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Comparison between actual output and expected output.
 *
 * @param {*} actualRaw - Actual program output
 * @param {*} expectedRaw - Expected testcase output
 * @returns {boolean} True if outputs match structurally/semantically
 */
export function areOutputsEqual(actualRaw, expectedRaw) {
  // Total function: malformed or adversarial output (e.g. JSON nested deeply
  // enough to overflow JSON.stringify) is a wrong answer, never an exception
  // that would turn the whole submission into ERROR.
  try {
    return compareOutputs(actualRaw, expectedRaw);
  } catch {
    return false;
  }
}

function compareOutputs(actualRaw, expectedRaw) {
  const normActual = normalizeOutput(actualRaw);
  const normExpected = normalizeOutput(expectedRaw);
  if (normActual === normExpected) return true;

  // Whitespace-normalized match (e.g. "a  b\n" vs "a b").
  const flatActual = String(actualRaw ?? "").trim().replace(/\s+/g, " ");
  const flatExpected = String(expectedRaw ?? "").trim().replace(/\s+/g, " ");
  if (flatActual === flatExpected) return true;

  // A single-element array equals its element ("[42]" vs "42").
  const a = structureOf(normActual);
  const b = structureOf(normExpected);
  if (a !== undefined && b !== undefined) {
    const sameValue = (x, y) => {
      if (JSON.stringify(x) === JSON.stringify(y)) return true;
      const sx = scalarText(x);
      const sy = scalarText(y);
      return sx !== null && sx === sy;
    };
    if (Array.isArray(a) && a.length === 1 && !Array.isArray(b) && sameValue(a[0], b)) return true;
    if (Array.isArray(b) && b.length === 1 && !Array.isArray(a) && sameValue(b[0], a)) return true;
  }

  return false;
}
