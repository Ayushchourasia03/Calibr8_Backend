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

const NUMBER_TAG = "\u0000n:";

/** Canonical form of a numeric lexeme, or null when it is not a number. */
function canonicalNumber(lexeme) {
  const text = String(lexeme).trim();
  if (/^[+-]?\d+$/.test(text)) return BigInt(text).toString();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // Non-integer lexemes compare by double value; integral ones ("1e3",
  // "5.0") therefore equal the integer they denote.
  return String(value);
}

const tagNumber = (canonical) => `${NUMBER_TAG}${canonical}`;

/**
 * JSON.parse that keeps exact numeric values: every number becomes a tagged
 * canonical string, built from its source text (no precision loss).
 */
function parseExactJson(text) {
  return JSON.parse(text, function reviver(_key, value, context) {
    if (typeof value === "number") {
      const canonical = canonicalNumber(context?.source ?? String(value));
      return tagNumber(canonical ?? String(value));
    }
    return value;
  });
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
