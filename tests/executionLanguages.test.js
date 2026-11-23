import assert from "node:assert/strict";
import app from "../src/app.js";

const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}/api/execution/languages`;

try {
  const response = await fetch(baseUrl);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    body.languages.map(({ key }) => key).sort(),
    ["c", "cpp", "java", "javascript", "python"],
  );
  assert.ok(body.languages.every((language) => language.label && language.monacoLanguage));

  console.log("Execution language API tests passed.");
} finally {
  server.close();
}
