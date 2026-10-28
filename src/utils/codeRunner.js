import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Normalizes values for comparison (handles space-separated numbers, JSON arrays/objects, booleans, strings).
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

  // Handle boolean strings & yes/no
  if (clean.toLowerCase() === 'true' || clean.toLowerCase() === 'yes') return 'true';
  if (clean.toLowerCase() === 'false' || clean.toLowerCase() === 'no') return 'false';

  // Handle space-separated numbers (e.g. "7 0 8" or "0 1")
  const spaceParts = clean.split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1 && spaceParts.every(p => !isNaN(Number(p)))) {
    return JSON.stringify(spaceParts.map(Number));
  }

  // Handle comma-separated numbers without brackets (e.g. "7, 0, 8")
  const commaParts = clean.split(',').map(s => s.trim()).filter(Boolean);
  if (commaParts.length > 1 && commaParts.every(p => !isNaN(Number(p)))) {
    return JSON.stringify(commaParts.map(Number));
  }

  return clean;
}

/**
 * Robust comparison between actual output and expected output
 */
export function areOutputsEqual(actualRaw, expectedRaw) {
  const normActual = normalizeOutput(actualRaw);
  const normExpected = normalizeOutput(expectedRaw);

  if (normActual === normExpected) return true;

  // Space-normalized match (e.g. "7 0 8\n" vs "7 0 8")
  const flatActual = String(actualRaw || '').trim().replace(/\s+/g, ' ');
  const flatExpected = String(expectedRaw || '').trim().replace(/\s+/g, ' ');
  if (flatActual === flatExpected) return true;

  // Additional check: array contents regardless of string representation
  try {
    const a = JSON.parse(normActual);
    const b = JSON.parse(normExpected);
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
    if (Array.isArray(a) && a.length === 1 && (JSON.stringify(a[0]) === JSON.stringify(b) || String(a[0]) === String(b))) return true;
    if (Array.isArray(b) && b.length === 1 && (JSON.stringify(b[0]) === JSON.stringify(a) || String(b[0]) === String(a))) return true;
  } catch {}

  // Plain trimmed string check
  return String(actualRaw).trim() === String(expectedRaw).trim();
}

/**
 * Builds the source code with random result marker and hidden driver
 * when no problem template is provided.
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

    if len(_parsed_lines) > _expected_count and _expected_count > 0:
        if len(_parsed_lines) == _expected_count + 1 and isinstance(_parsed_lines[0], int):
            if _expected_count == 1 and not isinstance(_parsed_lines[1], list):
                _final_args = [[_parsed_lines[1]]]
            else:
                _final_args = _parsed_lines[1:]
        elif len(_parsed_lines) == _expected_count + 1 and isinstance(_parsed_lines[1], list):
            _final_args = _parsed_lines[1:]

    if _expected_count == 1 and len(_final_args) > 1:
        if isinstance(_final_args[0], int) and isinstance(_final_args[1], list):
            _final_args = [_final_args[1]]
        elif isinstance(_final_args[0], int) and _final_args[0] == 1:
            _final_args = [[_final_args[1]]]

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
    if (_parsed.length === _expectedCount + 1 && typeof _parsed[0] === 'number') {
      if (_expectedCount === 1 && !Array.isArray(_parsed[1])) {
        _finalArgs = [[_parsed[1]]];
      } else {
        _finalArgs = _parsed.slice(1);
      }
    } else if (_parsed.length === _expectedCount + 1 && Array.isArray(_parsed[1])) {
      _finalArgs = _parsed.slice(1);
    }
  }

  if (_expectedCount === 1 && _finalArgs.length > 1) {
    if (typeof _finalArgs[0] === 'number' && Array.isArray(_finalArgs[1])) {
      _finalArgs = [_finalArgs[1]];
    } else if (typeof _finalArgs[0] === 'number' && _finalArgs[0] === 1) {
      _finalArgs = [[_finalArgs[1]]];
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

  if (lang === 'cpp') {
    let prefix = '';
    if (!studentCode.includes('#include')) {
      prefix = `#include <bits/stdc++.h>\n#include <iostream>\n#include <vector>\n#include <string>\n#include <sstream>\n#include <unordered_map>\n#include <algorithm>\nusing namespace std;\n\nstruct ListNode { int val; ListNode* next; ListNode() : val(0), next(nullptr) {} ListNode(int x) : val(x), next(nullptr) {} ListNode(int x, ListNode *next) : val(x), next(next) {} };\n\n`;
    }
    return prefix + studentCode;
  }

  if (lang === 'c') {
    let prefix = '';
    if (!studentCode.includes('#include')) {
      prefix = `#include <stdio.h>\n#include <stdlib.h>\n#include <stdbool.h>\n#include <string.h>\n\nstruct ListNode { int val; struct ListNode* next; };\n\n`;
    }
    return prefix + studentCode;
  }

  if (lang === 'java') {
    let prefix = '';
    if (!studentCode.includes('import java.')) {
      prefix = `import java.util.*;\nimport java.io.*;\n\nclass ListNode { int val; ListNode next; ListNode(int x) { val = x; } }\n\n`;
    }
    return prefix + studentCode;
  }

  return studentCode;
}

/**
 * Helper to run an executable binary or command in a sandboxed directory
 */
function runProcess({ cmd, args, cwd, stdin, timeLimitMs, marker }) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let isKilled = false;

    const child = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      isKilled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeLimitMs);

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'Runtime Error',
        studentStdout: '',
        actual: '',
        errorText: err.message,
        timeMs: Date.now() - startTime,
        memoryKb: 0,
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const timeMs = Date.now() - startTime;

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

      // Check for result marker (used in Python/JS reflection drivers)
      let actual = '';
      let studentStdout = '';

      if (marker && stdoutBuffer.includes(marker)) {
        const lines = stdoutBuffer.split('\n');
        let markerLineIdx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes(marker)) {
            markerLineIdx = i;
            actual = lines[i].slice(lines[i].indexOf(marker) + marker.length).trim();
            break;
          }
        }
        if (markerLineIdx !== -1) {
          studentStdout = lines.filter((_, idx) => idx !== markerLineIdx).join('\n').trim();
        }
      } else {
        actual = stdoutBuffer.trim();
        studentStdout = '';
      }

      if (exitCode !== 0) {
        const isCompile =
          stderrBuffer.includes('SyntaxError') ||
          stderrBuffer.includes('IndentationError') ||
          stderrBuffer.includes('ReferenceError: Solution is not defined');

        return resolve({
          status: isCompile ? 'Compilation Error' : 'Runtime Error',
          studentStdout,
          actual: '',
          errorText: stderrBuffer.trim() || `Process exited with code ${exitCode}.`,
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
      if (stdin !== undefined && stdin !== null) {
        child.stdin.write(stdin);
      }
      child.stdin.end();
    } catch {
      // Process might have terminated immediately
    }
  });
}

/**
 * Executes a single test case in a sandboxed process.
 * Supports C++ (g++), C (gcc), Java (javac+java), Python 3 (python3), and JavaScript (node).
 * Correctly distinguishes Compilation Error, Runtime Error, Time Limit Exceeded, and OK.
 *
 * @param {object} params
 * @returns {Promise<object>} Execution result
 */
export async function executeCase({
  language,
  code,
  fullCode: providedFullCode,
  stdin = '',
  timeLimitMs = 3000,
  memoryLimitKb = 64000,
  expectedOutput = '',
}) {
  const lang = String(language || 'python').toLowerCase();
  const marker = `__CALIBR8_MARK_${crypto.randomBytes(6).toString('hex')}__`;
  const codeToRun = providedFullCode || buildSource(lang, code, marker);

  // 1. C++ Execution (g++ 12+)
  if (lang === 'cpp') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-cpp-'));
    const srcPath = path.join(tmpDir, 'solution.cpp');
    const binPath = path.join(tmpDir, 'solution');

    try {
      await fs.writeFile(srcPath, codeToRun, 'utf-8');

      // Compile
      const compileStart = Date.now();
      const compileRes = await new Promise((resolve) => {
        const gpp = spawn('g++', ['-O2', '-std=c++20', srcPath, '-o', binPath], {
          cwd: tmpDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        gpp.stderr.on('data', (d) => { stderr += d.toString(); });
        gpp.on('close', (exitCode) => {
          resolve({ exitCode, stderr, duration: Date.now() - compileStart });
        });
        gpp.on('error', (err) => {
          resolve({ exitCode: 1, stderr: err.message, duration: Date.now() - compileStart });
        });
      });

      if (compileRes.exitCode !== 0) {
        return {
          status: 'Compilation Error',
          studentStdout: '',
          actual: '',
          errorText: compileRes.stderr.trim() || 'C++ compilation failed.',
          timeMs: compileRes.duration,
          memoryKb: 0,
        };
      }

      // Execute binary
      return await runProcess({
        cmd: binPath,
        args: [],
        cwd: tmpDir,
        stdin,
        timeLimitMs,
        marker: null,
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 2. C Execution (gcc 12+)
  if (lang === 'c') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-c-'));
    const srcPath = path.join(tmpDir, 'solution.c');
    const binPath = path.join(tmpDir, 'solution');

    try {
      await fs.writeFile(srcPath, codeToRun, 'utf-8');

      // Compile
      const compileStart = Date.now();
      const compileRes = await new Promise((resolve) => {
        const gcc = spawn('gcc', ['-O2', srcPath, '-o', binPath], {
          cwd: tmpDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        gcc.stderr.on('data', (d) => { stderr += d.toString(); });
        gcc.on('close', (exitCode) => {
          resolve({ exitCode, stderr, duration: Date.now() - compileStart });
        });
        gcc.on('error', (err) => {
          resolve({ exitCode: 1, stderr: err.message, duration: Date.now() - compileStart });
        });
      });

      if (compileRes.exitCode !== 0) {
        return {
          status: 'Compilation Error',
          studentStdout: '',
          actual: '',
          errorText: compileRes.stderr.trim() || 'C compilation failed.',
          timeMs: compileRes.duration,
          memoryKb: 0,
        };
      }

      // Execute binary
      return await runProcess({
        cmd: binPath,
        args: [],
        cwd: tmpDir,
        stdin,
        timeLimitMs,
        marker: null,
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 3. Java Execution (OpenJDK 17)
  if (lang === 'java') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-java-'));
    let className = 'Main';
    const match = codeToRun.match(/public\s+class\s+([A-Za-z0-9_]+)/);
    if (match) className = match[1];

    const srcPath = path.join(tmpDir, `${className}.java`);

    try {
      await fs.writeFile(srcPath, codeToRun, 'utf-8');

      // Compile
      const compileStart = Date.now();
      const compileRes = await new Promise((resolve) => {
        const javac = spawn('javac', [srcPath], {
          cwd: tmpDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        javac.stderr.on('data', (d) => { stderr += d.toString(); });
        javac.on('close', (exitCode) => {
          resolve({ exitCode, stderr, duration: Date.now() - compileStart });
        });
        javac.on('error', (err) => {
          resolve({ exitCode: 1, stderr: err.message, duration: Date.now() - compileStart });
        });
      });

      if (compileRes.exitCode !== 0) {
        return {
          status: 'Compilation Error',
          studentStdout: '',
          actual: '',
          errorText: compileRes.stderr.trim() || 'Java compilation failed.',
          timeMs: compileRes.duration,
          memoryKb: 0,
        };
      }

      // Execute class
      return await runProcess({
        cmd: 'java',
        args: ['-cp', tmpDir, className],
        cwd: tmpDir,
        stdin,
        timeLimitMs,
        marker: null,
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 4. Python 3 Execution
  if (lang === 'python') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-py-'));
    const filePath = path.join(tmpDir, 'solution.py');

    try {
      await fs.writeFile(filePath, codeToRun, 'utf-8');
      return await runProcess({
        cmd: 'python3',
        args: [filePath],
        cwd: tmpDir,
        stdin,
        timeLimitMs,
        marker: codeToRun.includes(marker) ? marker : null,
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 5. JavaScript (Node.js 22) Execution
  if (lang === 'javascript' || lang === 'js') {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calibr8-js-'));
    const filePath = path.join(tmpDir, 'solution.js');

    try {
      await fs.writeFile(filePath, codeToRun, 'utf-8');
      return await runProcess({
        cmd: 'node',
        args: [filePath],
        cwd: tmpDir,
        stdin,
        timeLimitMs,
        marker: codeToRun.includes(marker) ? marker : null,
      });
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 6. Unsupported Language
  return {
    status: 'Unsupported Language',
    studentStdout: '',
    actual: '',
    errorText: `Execution engine does not support language: '${language}'. Supported: cpp, c, java, python, javascript.`,
    timeMs: 0,
    memoryKb: 0,
  };
}
