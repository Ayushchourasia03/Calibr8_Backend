import bcrypt from 'bcryptjs';

export const SALT_ROUNDS = 12;

// Valid bcrypt hash of a random throwaway value, compared against when the
// account does not exist so login takes the same time either way (no account
// enumeration through response timing).
const DUMMY_HASH = bcrypt.hashSync(`calibr8-dummy-${Math.random()}`, SALT_ROUNDS);

/**
 * Hash a plain-text password.
 * @param {string} password
 * @returns {Promise<string>}
 */
export const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

/**
 * Compare a plain-text password against its hash. A missing hash still
 * spends the same time and returns false.
 * @param {string} password
 * @param {string | null | undefined} hash
 * @returns {Promise<boolean>}
 */
export const comparePassword = async (password, hash) => {
  if (typeof password !== 'string') return false;
  if (typeof hash !== 'string' || !/^\$2[aby]\$\d\d\$/.test(hash)) {
    await bcrypt.compare(password, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(password, hash);
};

/** True when a stored hash uses fewer rounds than SALT_ROUNDS (rehash on login). */
export const needsRehash = (hash) => {
  try {
    return bcrypt.getRounds(hash) < SALT_ROUNDS;
  } catch {
    return false;
  }
};
