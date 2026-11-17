/**
 * Python code-lab worker (module worker).
 *
 * Loads Pyodide from the app's own origin, runs the learner's entry file, then
 * runs each declared test in a fresh namespace and reports the workspace.
 * Nothing here interprets results — the main thread's pure evaluator does that.
 *
 * Isolation tier: browser. The worker removes the page's network and storage
 * APIs before learner code runs, but a worker is not a security boundary
 * against a determined author of generated code. High-stakes labs belong in the
 * operator-gated server isolation tier.
 */

const WORKSPACE = '/workspace';
const PYODIDE_BASE = '/vendor/pyodide/';

let pyodidePromise = null;

function post(message) {
  self.postMessage(message);
}

function blockEgress() {
  const deny = (name) => {
    const fail = () => {
      throw new Error(`Network access is disabled in the code lab (${name}).`);
    };
    try {
      Object.defineProperty(globalThis, name, {
        value: fail,
        configurable: false,
        writable: false,
      });
    } catch {
      try {
        globalThis[name] = fail;
      } catch {
        /* non-configurable host binding: leaving it is reported by the tier, not hidden */
      }
    }
  };
  deny('fetch');
  deny('XMLHttpRequest');
  deny('WebSocket');
  deny('EventSource');
  deny('importScripts');
  deny('BroadcastChannel');
  deny('indexedDB');
  deny('caches');
  try {
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: false });
  } catch {
    /* optional hardening */
  }
}

async function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const indexURL = new URL(PYODIDE_BASE, self.location.origin).href;
      const mod = await import(/* webpackIgnore: true */ indexURL + 'pyodide.mjs');
      const py = await mod.loadPyodide({
        indexURL,
        stdout: () => {},
        stderr: () => {},
        env: { HOME: '/home/learner' },
      });
      // The bridge can re-enter JS, so disable package loading as well as the
      // page's I/O globals before any learner code exists in the interpreter.
      py.loadPackage = () =>
        Promise.reject(new Error('Package loading is disabled in the code lab.'));
      py.loadPackagesFromImports = () =>
        Promise.reject(new Error('Package loading is disabled in the code lab.'));
      blockEgress();
      py.runPython(String.raw`
import os, sys, runpy, traceback

os.makedirs('/workspace', exist_ok=True)
os.chdir('/workspace')
if '/workspace' not in sys.path:
    sys.path.insert(0, '/workspace')

def __activity_entry__(path):
    try:
        runpy.run_path(path, run_name='__main__')
        return 0
    except SystemExit as exc:
        code = exc.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1

def __activity_tests__(tests):
    results = []
    for test in tests:
        # Each test gets a fresh import of the learner's workspace modules, so
        # one test cannot pass because another already imported a stale file.
        for name in list(sys.modules):
            module = sys.modules.get(name)
            file = getattr(module, '__file__', '') or ''
            if file.startswith('/workspace/'):
                del sys.modules[name]
        namespace = {'__name__': '__activity_test__'}
        try:
            exec(compile(test['code'], '<test ' + test['id'] + '>', 'exec'), namespace)
            results.append({'id': test['id'], 'passed': True})
        except BaseException:
            results.append({
                'id': test['id'],
                'passed': False,
                'message': traceback.format_exc(limit=4),
            })
    return results

def __activity_prepare__():
    os.chdir('/workspace')
    if '/workspace' not in sys.path:
        sys.path.insert(0, '/workspace')

def __activity_reset__():
    import shutil
    shutil.rmtree('/workspace', ignore_errors=True)
    os.makedirs('/workspace', exist_ok=True)
    return '/workspace'

def __activity_files__():
    import json
    out = {}
    for root, dirs, names in os.walk('/workspace'):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for name in names:
            full = os.path.join(root, name)
            relative = os.path.relpath(full, '/workspace').replace(os.sep, '/')
            try:
                with open(full, 'r', encoding='utf-8') as handle:
                    out[relative] = handle.read()
            except (UnicodeDecodeError, OSError):
                pass
    return json.dumps(out)

__activity_prepare__()
`);
      return py;
    })();
  }
  return pyodidePromise;
}

function writeWorkspace(py, files) {
  py.FS.mkdirTree(WORKSPACE);
  for (const [relative, content] of Object.entries(files || {})) {
    const full = WORKSPACE + '/' + relative;
    const slash = full.lastIndexOf('/');
    if (slash > WORKSPACE.length) py.FS.mkdirTree(full.slice(0, slash));
    py.FS.writeFile(full, content, { encoding: 'utf8' });
  }
}

function pythonString(value) {
  // JSON string escapes are valid Python string escapes for the path values the
  // validator admits (no raw quotes or control characters survive JSON).
  return JSON.stringify(value);
}

function collect(stream, chunk) {
  if (!chunk) return;
  stream.push(chunk.endsWith('\n') ? chunk : chunk + '\n');
}

async function runRequest(py, request) {
  const started = performance.now();
  const stdout = [];
  const stderr = [];
  let capture = true;
  py.setStdout({
    batched: (chunk) => {
      if (capture) collect(stdout, chunk);
    },
  });
  py.setStderr({
    batched: (chunk) => {
      if (capture) collect(stderr, chunk);
    },
  });

  currentStage = 'reset';
  py.runPython('__activity_reset__()');
  currentStage = 'write';
  writeWorkspace(py, request.files);
  currentStage = 'prepare';
  py.runPython('__activity_prepare__()');

  const entryFile = String(request.entryFile || 'main.py');
  // The path is validated against the workspace by the scene validator; quote
  // it rather than interpolating it into Python source.
  currentStage = 'entry';
  const status = await py.runPythonAsync(
    `__activity_entry__(${pythonString(WORKSPACE + '/' + entryFile)})`,
  );

  // The submission's output and file snapshot belong to the entry run. Tests
  // import the same modules, which re-executes top-level code, so start them
  // from a clean copy and stop capturing: a test import must not rewrite the
  // learner's stdout or the files an `expectFile` check reads.
  currentStage = 'files';
  const files = JSON.parse(py.runPython('__activity_files__()'));
  capture = false;

  let tests;
  if (Array.isArray(request.tests) && request.tests.length > 0) {
    currentStage = 'tests';
    py.runPython('__activity_reset__()');
    writeWorkspace(py, request.files);
    py.runPython('__activity_prepare__()');
    const fn = py.globals.get('__activity_tests__');
    const arg = py.toPy(
      request.tests.map((test) => ({
        id: String(test.id),
        name: String(test.name),
        code: String(test.code),
      })),
    );
    try {
      const proxy = fn(arg);
      tests = proxy.toJs({ dict_converter: Object.fromEntries });
      proxy.destroy();
    } finally {
      if (arg && typeof arg.destroy === 'function') arg.destroy();
      if (fn && typeof fn.destroy === 'function') fn.destroy();
    }
  }

  currentStage = 'done';
  return {
    status: 'ok',
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: Number(status) || 0,
    files,
    tests,
    durationMs: Math.round(performance.now() - started),
  };
}

let currentStage = 'init';

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== 'run' || typeof message.runId !== 'string') return;
  try {
    const py = await getPyodide();
    // The controller starts its hard timeout here, so interpreter start-up is
    // never billed to the learner's run.
    post({ type: 'started', runId: message.runId });
    const result = await runRequest(py, message.request || {});
    post({ type: 'result', runId: message.runId, result });
  } catch (error) {
    post({
      type: 'error',
      runId: message.runId,
      message: describeError(error),
    });
  }
};

function describeError(error) {
  if (!error || typeof error !== 'object') return String(error);
  const parts = [`stage=${currentStage}`];
  try {
    if (error.name) parts.push(String(error.name));
    if (error.message) parts.push(String(error.message));
    if (error.errno) parts.push(`errno=${String(error.errno)}`);
    if (error.code) parts.push(`code=${String(error.code)}`);
    if (typeof error.stack === 'string') parts.push(error.stack);
    if (parts.length === 0) {
      const keys = Object.getOwnPropertyNames(error).slice(0, 12);
      for (const key of keys) {
        try {
          parts.push(`${key}=${String(error[key])}`);
        } catch {
          /* skip unreadable */
        }
      }
    }
  } catch {
    /* fall through */
  }
  return parts.length > 0 ? parts.join('\n') : Object.prototype.toString.call(error);
}
