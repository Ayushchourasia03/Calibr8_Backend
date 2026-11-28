import bcrypt from 'bcryptjs';
import { hashInPool, compareInPool } from '../services/passwordPool.js';

export const SALT_ROUNDS = 12;

// Upper bound on a password accepted by any endpoint before bcrypt runs
// (SA-M1). bcrypt only uses the first 72 bytes; registration enforces 72.
// The higher bound here only exists so that older accounts with longer
// passwords can still sign in, while multi-megabyte inputs are rejected.
export const MAX_PASSWORD_INPUT_BYTES = 1024;

export function isPasswordInputTooLong(password) {
  return typeof password === 'string' && Buffer.byteLength(password, 'utf-8') > MAX_PASSWORD_INPUT_BYTES;
}

// Valid cost-12 bcrypt hash of a random value that was discarded when it was
// generated. It is compared against when the account does not exist, so login
// takes the same time either way (no account enumeration through timing).
// A constant avoids a ~0.4 s synchronous hashSync at startup.
const DUMMY_HASH = '$2b$12$z/xpYoUL4X1XIovvzReQSOk26kVrOe9rQFHN98PtFYGSCE9x7TQhe';

/**
 * Hash a plain-text password (off the event loop, see services/passwordPool.js).
 * @param {string} password
 * @returns {Promise<string>}
 */
export const hashPassword = (password) => hashInPool(password, SALT_ROUNDS);

/**
 * Compare a plain-text password against its hash (off the event loop). A
 * missing hash still spends the same time and returns false.
 * @param {string} password
 * @param {string | null | undefined} hash
 * @returns {Promise<boolean>}
 */
export const comparePassword = async (password, hash) => {
  if (typeof password !== 'string' || isPasswordInputTooLong(password)) return false;
  if (typeof hash !== 'string' || !/^\$2[aby]\$\d\d\$/.test(hash)) {
    await compareInPool(password, DUMMY_HASH);
    return false;
  }
  return compareInPool(password, hash);
};

/** True when a stored hash uses fewer rounds than SALT_ROUNDS (rehash on login). */
export const needsRehash = (hash) => {
  try {
    return bcrypt.getRounds(hash) < SALT_ROUNDS;
  } catch {
    return false;
  }
};
