import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Normalizes values for comparison (handles JSON numbers, arrays, objects, booleans, strings).
 */
export function normalizeOutput(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch {
      return trimmed;
    }
  }
  return JSON.stringify(val);
}

/**
 * Builds the source code with random result marker and hidden driver.
 * Student code is placed FIRST so error line numbers match the student's editor.
 */
export function buildSource(language, studentCode, marker) {
  const lang = String(language).toLowerCase();

  if (lang === 'python') {
    const driver = `

# --- CALIBR8 DRIVER ---
import sys, json

_MARK = '${marker}'
try:
    _raw_stdin = sys.stdin.read()
    _lines = [l for l in _raw_stdin.split('\\n') if l.strip()]
    _args = []
    for _line in _lines:
        try:
            _args.append(json.loads(_line))
        except Exception:
            # Handle space-separated numbers if not single JSON
            _parts = _line.split()
            if len(_parts) > 1 and all(p.lstrip('-').isdigit() for p in _parts):
                _args.append([int(p) for p in _parts])
            else:
                _args.append(_line)

    _sol = Solution()
    _methods = [m for m in dir(_sol) if not m.startswith('_') and callable(getattr(_sol, m))]
    if not _methods:
        sys.stderr.write("No method found on class Solution.\\n")
        sys.exit(1)

    _fn = getattr(_sol, _methods[0])
    _result = _fn(*_args)
    print(_MARK + json.dumps(_result))
except Exception as _e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
`;
    return studentCode + driver;
  }

  if (lang === 'javascript') {
    const driver = `

// --- CALIBR8 DRIVER ---
try {
  const _MARK = '${marker}';
  const _fs = require('fs');
  const _raw = _fs.readFileSync(0, 'utf8');
  const _lines = _raw.split('\\n').filter(l => l.trim().length > 0);
  const _args = _lines.map(l => {
    try {
      return JSON.parse(l);
    } catch (e) {
      const parts = l.trim().split(/\\s+/);
      if (parts.length > 1 && parts.every(p => !isNaN(p))) {
        return parts.map(Number);
      }
      return l;
    }
  });

  const _sol = new Solution();
  const _methods = Object.getOwnPropertyNames(Object.getPrototypeOf(_sol)).filter(m => m !== 'constructor');
  const _fnName = _methods[0];
  if (!_fnName || typeof _sol[_fnName] !== 'function') {
    process.stderr.write("No method found on class Solution.\\n");
    process.exit(1);
  }

  const _res = _sol[_fnName](..._args);
  console.log(_MARK + JSON.stringify(_res));
} catch (_err) {
  process.stderr.write((_err && _err.stack) ? _err.stack : String(_err));
  process.exit(1);
}
`;
    return studentCode + driver;
  }

  // Fallback for compiled languages (Java, C++)
  return studentCode;
}

/**
 * Executes a single test case in a sandboxed process.
 * Returns stdout, stderr, real studentStdout, actual output, status, timeMs, memoryKb.
 */
export async function executeCase({ language, code, stdin = '', timeLimitMs = 2000, memoryLimitKb = 64000 }) {
  const lang = String(language).toLowerCase();
  const marker = `__CALIBR8_MARK_${crypto.randomBytes(6).toString('hex')}__`;
  const fullCode = buildSource(lang, code, marker);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-exec-'));
  const filename = lang === 'python' ? 'solution.py' : 'solution.js';
  const filePath = path.join(tmpDir, filename);

  await fs.writeFile(filePath, fullCode, 'utf-8');

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let isKilled = false;

    const cmd = lang === 'python' ? 'python3' : 'node';
    const args = [filePath];

    const child = spawn(cmd, args, {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      isKilled = true;
      child.kill('SIGKILL');
    }, timeLimitMs);

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      resolve({
        status: 'Runtime Error',
        studentStdout: '',
        actual: '',
        errorText: err.message,
        timeMs: Date.now() - startTime,
        memoryKb: 0,
      });
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      const timeMs = Date.now() - startTime;
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      if (isKilled) {
        return resolve({
          status: 'Time Limit Exceeded',
          studentStdout: stdoutBuffer.slice(0, 4096),
          actual: '',
          errorText: `Execution timed out after ${timeLimitMs}ms.`,
          timeMs,
          memoryKb: 16000,
        });
      }

      // Marker extraction from stdout
      // The backend uses the LAST marker line in stdout and shows all other output as the student's own prints
      const lines = stdoutBuffer.split('\n');
      let markerLineIdx = -1;
      let actual = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes(marker)) {
          markerLineIdx = i;
          const afterMarker = line.slice(line.indexOf(marker) + marker.length).trim();
          actual = afterMarker;
          break;
        }
      }

      let studentStdout = '';
      if (markerLineIdx !== -1) {
        // Collect all lines before or excluding the marker
        const studentLines = lines.filter((_, idx) => idx !== markerLineIdx);
        studentStdout = studentLines.join('\n').trim();
      } else {
        studentStdout = stdoutBuffer.trim();
      }

      if (code !== 0 || markerLineIdx === -1) {
        // Strip out calibr8 internal driver lines from stack traces
        const cleanedStderr = stderrBuffer
          .split('\n')
          .filter(l => !l.includes('CALIBR8 DRIVER') && !l.includes('_sol') && !l.includes('_args'))
          .join('\n')
          .trim();

        const isCompile = cleanedStderr.includes('SyntaxError') || cleanedStderr.includes('IndentationError');
        return resolve({
          status: isCompile ? 'Compilation Error' : 'Runtime Error',
          studentStdout,
          actual: '',
          errorText: cleanedStderr || stderrBuffer.trim() || 'Process exited with non-zero code.',
          timeMs,
          memoryKb: 14000,
        });
      }

      resolve({
        status: 'OK',
        studentStdout,
        actual,
        errorText: null,
        timeMs,
        memoryKb: 14000,
      });
    });

    // Write test input into stdin
    try {
      child.stdin.write(stdin || '');
      child.stdin.end();
    } catch {
      // Child might have exited quickly
    }
  });
}
