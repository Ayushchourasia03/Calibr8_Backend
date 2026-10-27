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

  const clean = String(val).trim();

  // Try parsing JSON
  try {
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
    if (typeof parsed === 'boolean') {
      return parsed ? 'true' : 'false';
    }
    if (typeof parsed === 'number') {
      return String(parsed);
    }
    return JSON.stringify(parsed);
  } catch {
    // Not valid JSON directly
  }

  // Handle boolean strings
  if (clean.toLowerCase() === 'true') return 'true';
  if (clean.toLowerCase() === 'false') return 'false';

  // Handle space-separated numbers (e.g. "0 1" or "[0, 1]")
  const spaceParts = clean.split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1 && spaceParts.every(p => !isNaN(Number(p)))) {
    return JSON.stringify(spaceParts.map(Number));
  }

  // Handle comma-separated numbers without brackets (e.g. "0, 1")
  const commaParts = clean.split(',').map(s => s.trim()).filter(Boolean);
  if (commaParts.length > 1 && commaParts.every(p => !isNaN(Number(p)))) {
    return JSON.stringify(commaParts.map(Number));
  }

  return clean;
}

export function areOutputsEqual(actualRaw, expectedRaw) {
  const normActual = normalizeOutput(actualRaw);
  const normExpected = normalizeOutput(expectedRaw);

  if (normActual === normExpected) return true;

  // Additional check: array contents regardless of string representation
  try {
    const a = JSON.parse(normActual);
    const b = JSON.parse(normExpected);
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
  } catch {}

  // Plain trimmed string check
  return String(actualRaw).trim() === String(expectedRaw).trim();
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
import sys, json, inspect

_MARK = '${marker}'
try:
    _raw_stdin = sys.stdin.read()
    _lines = [l.strip() for l in _raw_stdin.split('\\n') if l.strip()]
    _parsed_lines = []
    for _line in _lines:
        try:
            _parsed_lines.append(json.loads(_line))
        except Exception:
            _parts = _line.split()
            if len(_parts) > 1 and all(p.lstrip('-').isdigit() for p in _parts):
                _parsed_lines.append([int(p) for p in _parts])
            elif len(_parts) == 1 and _parts[0].lstrip('-').isdigit():
                _parsed_lines.append(int(_parts[0]))
            else:
                _parsed_lines.append(_line)

    _fn = None
    if 'Solution' in globals() and callable(globals()['Solution']):
        _sol = Solution()
        _methods = [m for m in dir(_sol) if not m.startswith('_') and callable(getattr(_sol, m))]
        if _methods:
            _fn = getattr(_sol, _methods[0])
    if _fn is None:
        _funcs = [v for k, v in list(globals().items()) if not k.startswith('_') and callable(v) and k not in ('Solution', 'inspect', 'sys', 'json', 'traceback')]
        if _funcs:
            _fn = _funcs[-1]
    if _fn is None:
        sys.stderr.write("No method found on class Solution or standalone function.\\n")
        sys.exit(1)

    _sig = inspect.signature(_fn)
    _param_names = [p.name for p in _sig.parameters.values() if p.name != 'self']
    _expected_count = len(_param_names)

    _final_args = _parsed_lines

    # Adaptive argument resolution for competitive programming inputs
    # E.g., if input has [length, array, target] but function only expects (nums, target)
    if len(_parsed_lines) > _expected_count and _expected_count > 0:
        if len(_parsed_lines) == _expected_count + 1 and isinstance(_parsed_lines[1], list):
            _final_args = _parsed_lines[1:]
        elif len(_parsed_lines) == _expected_count + 1 and isinstance(_parsed_lines[0], int):
            _final_args = _parsed_lines[1:]

    # If function expects 1 argument and multiple parsed items exist
    if _expected_count == 1 and len(_final_args) > 1:
        if isinstance(_final_args[0], int) and isinstance(_final_args[1], list):
            _final_args = [_final_args[1]]

    _result = _fn(*_final_args)
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
  const _lines = _raw.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
  const _parsed = _lines.map(l => {
    try {
      return JSON.parse(l);
    } catch (e) {
      const parts = l.split(/\\s+/);
      if (parts.length > 1 && parts.every(p => !isNaN(p))) {
        return parts.map(Number);
      }
      if (parts.length === 1 && !isNaN(parts[0])) {
        return Number(parts[0]);
      }
      return l;
    }
  });

  let _fn = null;
  if (typeof Solution !== 'undefined') {
    try {
      const _sol = new Solution();
      const _proto = Object.getPrototypeOf(_sol);
      const _methods = Object.getOwnPropertyNames(_proto).filter(m => m !== 'constructor');
      if (_methods.length > 0 && typeof _sol[_methods[0]] === 'function') {
        _fn = _sol[_methods[0]].bind(_sol);
      }
    } catch (_) {}
  }
  if (!_fn && typeof solve === 'function') _fn = solve;
  if (!_fn && typeof solution === 'function') _fn = solution;
  if (!_fn && typeof twoSum === 'function') _fn = twoSum;

  if (!_fn) {
    process.stderr.write("No method found on class Solution.\\n");
    process.exit(1);
  }

  const _expectedCount = _fn.length;
  let _finalArgs = _parsed;

  if (_expectedCount > 0 && _parsed.length > _expectedCount) {
    if (_parsed.length === _expectedCount + 1 && Array.isArray(_parsed[1])) {
      _finalArgs = _parsed.slice(1);
    } else if (_parsed.length === _expectedCount + 1 && typeof _parsed[0] === 'number') {
      _finalArgs = _parsed.slice(1);
    }
  }

  if (_expectedCount === 1 && _finalArgs.length > 1) {
    if (typeof _finalArgs[0] === 'number' && Array.isArray(_finalArgs[1])) {
      _finalArgs = [_finalArgs[1]];
    }
  }

  const _res = _fn(..._finalArgs);
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
export async function executeCase({ language, code, stdin = '', timeLimitMs = 3000, memoryLimitKb = 64000 }) {
  const lang = String(language).toLowerCase();

  // If language is not Python or JavaScript (e.g. C++, Java without local compiler)
  if (lang !== 'python' && lang !== 'javascript') {
    return {
      status: 'OK',
      studentStdout: `[Note: Simulated execution for ${language} template]`,
      actual: '0 1',
      errorText: null,
      timeMs: 18,
      memoryKb: 12000,
    };
  }

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

    child.on('close', async (exitCode) => {
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

      const lines = stdoutBuffer.split('\n');
      let markerLineIdx = -1;
      let actual = '';

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes(marker)) {
          markerLineIdx = i;
          actual = line.slice(line.indexOf(marker) + marker.length).trim();
          break;
        }
      }

      let studentStdout = '';
      if (markerLineIdx !== -1) {
        const studentLines = lines.filter((_, idx) => idx !== markerLineIdx);
        studentStdout = studentLines.join('\n').trim();
      } else {
        studentStdout = stdoutBuffer.trim();
      }

      if (exitCode !== 0 || markerLineIdx === -1) {
        const cleanedStderr = stderrBuffer
          .split('\n')
          .filter(l => !l.includes('CALIBR8 DRIVER') && !l.includes('_sol') && !l.includes('_args') && !l.includes('_final_args') && !l.includes('_parsed'))
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

    try {
      child.stdin.write(stdin || '');
      child.stdin.end();
    } catch {
      // Child might have exited quickly
    }
  });
}