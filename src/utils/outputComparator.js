/**
 * Calibr8 Output Normalization and Comparison Utilities
 *
 * Compares program output against expected testcase output,
 * handling space-separated numbers, JSON arrays/objects, booleans, and strings.
 */

/**
 * Normalizes values for comparison (handles space-separated numbers, JSON arrays/objects, booleans, strings).
 *
 * @param {*} val - Raw output string or object
 * @returns {string} Normalized string representation
 */
export function normalizeOutput(val) {
  if (val === null || val === undefined) return "";

  const clean = String(val).trim();

  // Try parsing JSON
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    if (typeof parsed === "boolean") {
      return parsed ? "true" : "false";
    }
    if (typeof parsed === "number") {
      return String(parsed);
    }
    return JSON.stringify(parsed);
  } catch {
    // Not valid JSON directly
  }

  // Handle boolean strings & yes/no
  if (clean.toLowerCase() === "true" || clean.toLowerCase() === "yes") return "true";
  if (clean.toLowerCase() === "false" || clean.toLowerCase() === "no") return "false";

  // Handle space-separated numbers (e.g. "7 0 8" or "0 1")
  const spaceParts = clean.split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1 && spaceParts.every((p) => !isNaN(Number(p)))) {
    return JSON.stringify(spaceParts.map(Number));
  }

  // Handle comma-separated numbers without brackets (e.g. "7, 0, 8")
  const commaParts = clean
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (commaParts.length > 1 && commaParts.every((p) => !isNaN(Number(p)))) {
    return JSON.stringify(commaParts.map(Number));
  }

  return clean;
}

/**
 * Robust comparison between actual output and expected output.
 *
 * @param {*} actualRaw - Actual program output
 * @param {*} expectedRaw - Expected testcase output
 * @returns {boolean} True if outputs match structurally/semantically
 */
export function areOutputsEqual(actualRaw, expectedRaw) {
  const normActual = normalizeOutput(actualRaw);
  const normExpected = normalizeOutput(expectedRaw);

  if (normActual === normExpected) return true;

  // Space-normalized match (e.g. "7 0 8\n" vs "7 0 8")
  const flatActual = String(actualRaw || "").trim().replace(/\s+/g, " ");
  const flatExpected = String(expectedRaw || "").trim().replace(/\s+/g, " ");
  if (flatActual === flatExpected) return true;

  // Additional check: array contents regardless of string representation
  try {
    const a = JSON.parse(normActual);
    const b = JSON.parse(normExpected);
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
    if (
      Array.isArray(a) &&
      a.length === 1 &&
      (JSON.stringify(a[0]) === JSON.stringify(b) || String(a[0]) === String(b))
    ) {
      return true;
    }
    if (
      Array.isArray(b) &&
      b.length === 1 &&
      (JSON.stringify(b[0]) === JSON.stringify(a) || String(b[0]) === String(a))
    ) {
      return true;
    }
  } catch {}

  // Plain trimmed string check
  return String(actualRaw).trim() === String(expectedRaw).trim();
}
