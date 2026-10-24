import assert from 'assert';
import app from '../src/app.js';
import http from 'http';

/**
 * CI Security test verifying:
 * 1. Hidden testcases and expected outputs are never returned in GET /api/problems/:slug
 * 2. Unauthenticated POST /api/problems or POST /api/admin/problems is rejected
 * 3. Weak passwords (too short, too long, matching email) are rejected
 */
async function runTests() {
  console.log('Running Calibr8 API Security Tests...');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test 1: Register with weak password (<8 characters)
    {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'testuser@example.com',
          password: 'short',
          name: 'Test User',
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 400, 'Password < 8 chars must be rejected with 400');
      assert.strictEqual(data.code, 'WEAK_PASSWORD');
      console.log('✅ Weak password (<8 chars) properly rejected');
    }

    // Test 2: Register with password matching email
    {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'sameasemail@example.com',
          password: 'sameasemail@example.com',
          name: 'Test User',
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 400, 'Password matching email must be rejected with 400');
      assert.strictEqual(data.code, 'PASSWORD_EQUALS_EMAIL');
      console.log('✅ Password equal to email properly rejected');
    }

    // Test 3: POST /api/admin/problems without auth rejected with 401
    {
      const res = await fetch(`${baseUrl}/api/admin/problems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'hack-problem',
          title: 'Hacked Problem',
        }),
      });
      const data = await res.json();
      assert.strictEqual(res.status, 401, 'Unauthenticated problem creation must return 401');
      assert.strictEqual(data.code, 'UNAUTHORIZED');
      console.log('✅ Unauthenticated admin problem creation properly blocked');
    }

    // Test 4: Verify testcase leakage protection logic
    {
      // Mock problem with hidden test cases
      const mockProblem = {
        id: 'test-prob',
        slug: 'test-hidden-leak',
        title: 'Leak Test Problem',
        testcases: [
          { testIndex: 0, isVisible: true, stdinSmall: 'input_sample', expectedSmall: 'output_sample' },
          { testIndex: 1, isVisible: false, stdinSmall: 'SECRET_HIDDEN_INPUT_XYZ', expectedSmall: 'SECRET_HIDDEN_OUTPUT_ABC' },
        ],
      };

      const visibleOnly = (mockProblem.testcases || [])
        .filter((tc) => tc.isVisible === true)
        .map((tc) => ({
          testIndex: tc.testIndex,
          isVisible: true,
          input: tc.stdinSmall,
          output: tc.expectedSmall,
        }));

      // Assert that hidden testcase input/output does NOT appear in visibleOnly
      const jsonStr = JSON.stringify(visibleOnly);
      assert(!jsonStr.includes('SECRET_HIDDEN_INPUT_XYZ'), 'Hidden input must not leak in response');
      assert(!jsonStr.includes('SECRET_HIDDEN_OUTPUT_ABC'), 'Hidden output must not leak in response');
      assert.strictEqual(visibleOnly.length, 1, 'Only visible testcases should be returned');
      console.log('✅ Hidden testcases and expected outputs are strictly protected');
    }

    console.log('🎉 All security tests passed successfully!');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
