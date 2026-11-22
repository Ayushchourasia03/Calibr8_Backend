// src/profiling/registry.js
//
// Problems that have a complexity-profiling definition. A definition provides
// a worst-case input generator, an input validator and a per-language driver.
// Problems without one are simply not profiled (the static analyzer remains).

import { addTwoNumbersProfile } from "./problems/addTwoNumbers.js";

const PROFILES = new Map([[addTwoNumbersProfile.slug, addTwoNumbersProfile]]);

export function getProfileDefinition(slug) {
  return PROFILES.get(slug) || null;
}

/** True when the problem has a profiling driver for this (normalized) language. */
export function isProfilingSupported(slug, language) {
  const def = getProfileDefinition(slug);
  return Boolean(def && def.drivers?.[language]);
}

/**
 * Conceptual interface from the design: input for (problem, language, size, pattern).
 * Returns null when the problem/language is not profiled.
 */
export function generateProfileInput(slug, language, size, pattern) {
  if (!isProfilingSupported(slug, language)) return null;
  const def = getProfileDefinition(slug);
  return def.generateInput(size, pattern || def.pattern);
}
