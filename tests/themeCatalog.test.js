import assert from "node:assert/strict";
import { STORE_THEMES, ensureStoreThemes, getStoreTheme } from "../src/data/storeThemes.js";

const records = new Map();
await ensureStoreThemes({
  theme: {
    upsert: async ({ where, update, create }) => {
      const current = records.get(where.slug);
      if (current) {
        Object.assign(current, update);
        return current;
      }
      records.set(where.slug, create);
      return create;
    },
  },
});

assert.equal(records.size, STORE_THEMES.length);
assert.deepEqual(records.get("orbit"), getStoreTheme("orbit"));
assert.equal(getStoreTheme("unknown-theme"), null);

console.log("Theme catalog synchronization tests passed.");
