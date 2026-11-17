/**
 * Deterministic terminal simulation for command-line basics labs.
 *
 * This is deliberately a small, closed shell over an in-memory filesystem, not
 * a real process. It runs synchronously on the page, cannot touch the host, and
 * produces the same transcript on every machine. Real command execution belongs
 * to the operator-gated server isolation tier, never to this module.
 *
 * The supported command set is the lesson's vocabulary: navigation, file
 * inspection/editing, and environment variables. Unknown commands fail like a
 * shell would and leave the session usable.
 */
import type { ActivityRunResult } from './protocol';

export const TERMINAL_HOME = '/home/learner';
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';
const MAX_COMMANDS = 500;
const MAX_OUTPUT_CHARS = 200_000;

interface FileSystem {
  files: Map<string, string>;
  dirs: Set<string>;
}

interface SimState {
  cwd: string;
  env: Record<string, string>;
  fs: FileSystem;
  stdout: string;
  stderr: string;
  exitCode: number;
  outputChars: number;
}

interface ParsedCommand {
  argv: string[];
  redirect?: { path: string; append: boolean };
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function resolvePath(cwd: string, input: string, env: Record<string, string>): string {
  let target = input;
  if (target === '~') target = env.HOME ?? TERMINAL_HOME;
  else if (target.startsWith('~/')) target = `${env.HOME ?? TERMINAL_HOME}${target.slice(1)}`;
  const segments = target.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}` === '/' ? '/' : `/${segments.join('/')}`;
}

function ensureDir(state: SimState, path: string): void {
  if (path === '/') {
    state.fs.dirs.add('/');
    return;
  }
  const parent = parentPath(path);
  ensureDir(state, parent);
  state.fs.dirs.add(path);
}

function ensureParents(state: SimState, path: string): void {
  ensureDir(state, parentPath(path));
}

function writeFile(state: SimState, path: string, content: string, append: boolean): void {
  ensureParents(state, path);
  state.fs.files.set(path, append ? (state.fs.files.get(path) ?? '') + content : content);
}

function removePath(state: SimState, path: string): void {
  state.fs.files.delete(path);
  state.fs.dirs.delete(path);
  for (const file of [...state.fs.files.keys()]) {
    if (file.startsWith(`${path}/`)) state.fs.files.delete(file);
  }
  for (const dir of [...state.fs.dirs]) {
    if (dir.startsWith(`${path}/`)) state.fs.dirs.delete(dir);
  }
}

function copyPath(state: SimState, source: string, target: string): string | null {
  if (state.fs.files.has(source)) {
    writeFile(state, target, state.fs.files.get(source) ?? '', false);
    return null;
  }
  if (state.fs.dirs.has(source)) {
    ensureDir(state, target);
    for (const file of state.fs.files.keys()) {
      if (file.startsWith(`${source}/`)) {
        writeFile(
          state,
          `${target}${file.slice(source.length)}`,
          state.fs.files.get(file) ?? '',
          false,
        );
      }
    }
    for (const dir of state.fs.dirs) {
      if (dir.startsWith(`${source}/`)) ensureDir(state, `${target}${dir.slice(source.length)}`);
    }
    return null;
  }
  return `cannot stat '${source}': No such file or directory`;
}

function listDir(state: SimState, path: string): string[] {
  const names = new Set<string>();
  const prefix = path === '/' ? '/' : `${path}/`;
  for (const file of state.fs.files.keys()) {
    if (file.startsWith(prefix)) {
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
  }
  for (const dir of state.fs.dirs) {
    if (dir.startsWith(prefix) && dir !== path) {
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isDir(state: SimState, path: string): boolean {
  return state.fs.dirs.has(path);
}

function isFile(state: SimState, path: string): boolean {
  return state.fs.files.has(path);
}

function expandVariables(text: string, env: Record<string, string>): string {
  return text.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced: string | undefined, bare: string | undefined) =>
      env[braced ?? bare ?? ''] ?? '',
  );
}

/**
 * Split one command line into argv plus an optional stdout redirection.
 * Single quotes suppress `$` expansion; double quotes allow it. Unclosed
 * quotes are an error (nothing runs).
 */
function parseCommandLine(line: string, env: Record<string, string>): ParsedCommand | string {
  const argv: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let redirect: ParsedCommand['redirect'];

  const flush = () => {
    if (!tokenStarted) return;
    argv.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '$') {
        const rest = line.slice(index);
        const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
        if (match) {
          token += env[match[1] ?? match[2] ?? ''] ?? '';
          index += match[0].length - 1;
        } else {
          token += char;
        }
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      flush();
      continue;
    }
    if (char === '>') {
      flush();
      const append = line[index + 1] === '>';
      if (append) index += 1;
      const rest = line.slice(index + 1).trim();
      if (!rest) return 'syntax error near unexpected token `newline`';
      const target = parseCommandLine(rest, env);
      if (typeof target === 'string' || target.argv.length !== 1 || target.redirect) {
        return 'syntax error in redirection target';
      }
      redirect = { path: target.argv[0]!, append };
      return { argv, redirect };
    }
    if (char === '$') {
      const rest = line.slice(index);
      const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
      if (match) {
        token += env[match[1] ?? match[2] ?? ''] ?? '';
        index += match[0].length - 1;
      } else {
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) return 'unexpected EOF while looking for matching quote';
  flush();
  return redirect ? { argv, redirect } : { argv };
}

function writeOut(state: SimState, text: string): void {
  state.stdout += text;
  state.outputChars += text.length;
}

function writeErr(state: SimState, text: string): void {
  state.stderr += text.endsWith('\n') ? text : `${text}\n`;
  state.outputChars += text.length;
}

function emit(
  state: SimState,
  parsed: ParsedCommand,
  stdout: string,
  stderr: string,
  code: number,
): void {
  state.exitCode = code;
  if (stderr) writeErr(state, stderr);
  if (!parsed.redirect) {
    if (stdout) writeOut(state, stdout);
    return;
  }
  const target = resolvePath(state.cwd, parsed.redirect.path, state.env);
  if (isDir(state, target)) {
    writeErr(state, `cannot write '${parsed.redirect.path}': Is a directory`);
    state.exitCode = 1;
    return;
  }
  if (!isDir(state, parentPath(target))) {
    writeErr(state, `cannot write '${parsed.redirect.path}': No such file or directory`);
    state.exitCode = 1;
    return;
  }
  writeFile(state, target, stdout, parsed.redirect.append);
}

function takeOperands(argv: string[]): { flags: Set<string>; operands: string[] } {
  const flags = new Set<string>();
  const operands: string[] = [];
  for (const token of argv) {
    if (token.startsWith('-') && token !== '-') flags.add(token);
    else operands.push(token);
  }
  return { flags, operands };
}

function readFileForCommand(
  state: SimState,
  operand: string,
): { path: string; content: string } | string {
  const path = resolvePath(state.cwd, operand, state.env);
  if (!isFile(state, path)) return `cannot open '${operand}': No such file or directory`;
  return { path, content: state.fs.files.get(path) ?? '' };
}

function runLs(state: SimState, argv: string[]): { stdout: string; stderr: string; code: number } {
  const { flags, operands } = takeOperands(argv);
  const showAll = flags.has('-a') || flags.has('-la') || flags.has('-al');
  const long = flags.has('-l') || flags.has('-la') || flags.has('-al');
  const target = operands[0] ?? '.';
  const path = resolvePath(state.cwd, target, state.env);
  if (isFile(state, path)) {
    if (long) {
      const size = (state.fs.files.get(path) ?? '').length;
      return {
        stdout: `-rw-r--r-- 1 learner learner ${size} ${baseName(path)}\n`,
        stderr: '',
        code: 0,
      };
    }
    return { stdout: `${baseName(path)}\n`, stderr: '', code: 0 };
  }
  if (!isDir(state, path)) {
    return { stdout: '', stderr: `cannot access '${target}': No such file or directory`, code: 1 };
  }
  let names = listDir(state, path);
  if (!showAll) names = names.filter((name) => !name.startsWith('.'));
  if (showAll) names = ['.', '..', ...names];
  if (long) {
    return {
      stdout: names
        .map((name) => {
          const full = resolvePath(path, name, state.env);
          const size = isFile(state, full) ? (state.fs.files.get(full) ?? '').length : 4096;
          const kind = isDir(state, full) ? 'd' : '-';
          return `${kind}rw-r--r-- 1 learner learner ${size} ${name}`;
        })
        .join('\n')
        .concat('\n'),
      stderr: '',
      code: 0,
    };
  }
  return { stdout: names.length > 0 ? `${names.join('\n')}\n` : '', stderr: '', code: 0 };
}

function runCd(state: SimState, argv: string[]): { stdout: string; stderr: string; code: number } {
  const target = argv[0] ?? '~';
  const path = resolvePath(state.cwd, target, state.env);
  if (!isDir(state, path)) {
    return { stdout: '', stderr: `cd: ${target}: No such file or directory`, code: 1 };
  }
  state.cwd = path;
  return { stdout: '', stderr: '', code: 0 };
}

function runCat(state: SimState, argv: string[]): { stdout: string; stderr: string; code: number } {
  if (argv.length === 0) return { stdout: '', stderr: 'cat: missing operand', code: 1 };
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const operand of argv) {
    const file = readFileForCommand(state, operand);
    if (typeof file === 'string') {
      stderr += `${file}\n`;
      code = 1;
    } else {
      stdout += file.content;
    }
  }
  return { stdout, stderr, code };
}

function runMkdir(
  state: SimState,
  argv: string[],
): { stdout: string; stderr: string; code: number } {
  const recursive = argv[0] === '-p';
  const operands = recursive ? argv.slice(1) : argv;
  if (operands.length === 0) return { stdout: '', stderr: 'mkdir: missing operand', code: 1 };
  let stderr = '';
  let code = 0;
  for (const operand of operands) {
    const path = resolvePath(state.cwd, operand, state.env);
    if (state.fs.files.has(path)) {
      stderr += `mkdir: cannot create directory '${operand}': File exists\n`;
      code = 1;
      continue;
    }
    if (!recursive && !isDir(state, parentPath(path))) {
      stderr += `mkdir: cannot create directory '${operand}': No such file or directory\n`;
      code = 1;
      continue;
    }
    ensureDir(state, path);
  }
  return { stdout: '', stderr, code };
}

function runTouch(
  state: SimState,
  argv: string[],
): { stdout: string; stderr: string; code: number } {
  if (argv.length === 0) return { stdout: '', stderr: 'touch: missing file operand', code: 1 };
  let stderr = '';
  let code = 0;
  for (const operand of argv) {
    const path = resolvePath(state.cwd, operand, state.env);
    if (isDir(state, path)) {
      stderr += `touch: cannot touch '${operand}': Is a directory\n`;
      code = 1;
      continue;
    }
    if (!isDir(state, parentPath(path))) {
      stderr += `touch: cannot touch '${operand}': No such file or directory\n`;
      code = 1;
      continue;
    }
    if (!isFile(state, path)) writeFile(state, path, '', false);
  }
  return { stdout: '', stderr, code };
}

function runRm(state: SimState, argv: string[]): { stdout: string; stderr: string; code: number } {
  const { flags, operands } = takeOperands(argv);
  const recursive = flags.has('-r') || flags.has('-rf') || flags.has('-fr');
  const force = flags.has('-f') || flags.has('-rf') || flags.has('-fr');
  if (operands.length === 0 && !force) {
    return { stdout: '', stderr: 'rm: missing operand', code: 1 };
  }
  let stderr = '';
  let code = 0;
  for (const operand of operands) {
    const path = resolvePath(state.cwd, operand, state.env);
    if (!isFile(state, path) && !isDir(state, path)) {
      if (!force) {
        stderr += `rm: cannot remove '${operand}': No such file or directory\n`;
        code = 1;
      }
      continue;
    }
    if (isDir(state, path) && !recursive) {
      stderr += `rm: cannot remove '${operand}': Is a directory\n`;
      code = 1;
      continue;
    }
    removePath(state, path);
  }
  return { stdout: '', stderr, code };
}

function runCpMv(
  state: SimState,
  argv: string[],
  move: boolean,
): { stdout: string; stderr: string; code: number } {
  const { flags, operands } = takeOperands(argv);
  const recursive = flags.has('-r') || flags.has('-R') || flags.has('-rf');
  if (operands.length < 2) {
    return { stdout: '', stderr: `${move ? 'mv' : 'cp'}: missing destination operand`, code: 1 };
  }
  const source = resolvePath(state.cwd, operands[0]!, state.env);
  let target = resolvePath(state.cwd, operands[1]!, state.env);
  if (isDir(state, target)) target = `${target}/${baseName(source)}`;
  if (!isFile(state, source) && !isDir(state, source)) {
    return {
      stdout: '',
      stderr: `${move ? 'mv' : 'cp'}: cannot stat '${operands[0]}': No such file or directory`,
      code: 1,
    };
  }
  if (isDir(state, source) && !recursive) {
    return {
      stdout: '',
      stderr: `${move ? 'mv' : 'cp'}: omitting directory '${operands[0]}'`,
      code: 1,
    };
  }
  if (target.startsWith(`${source}/`)) {
    return { stdout: '', stderr: `cannot copy a directory into itself`, code: 1 };
  }
  if (!isDir(state, parentPath(target))) {
    return {
      stdout: '',
      stderr: `${move ? 'mv' : 'cp'}: cannot create '${operands[1]}': No such file or directory`,
      code: 1,
    };
  }
  const error = copyPath(state, source, target);
  if (error) return { stdout: '', stderr: error, code: 1 };
  if (move) removePath(state, source);
  return { stdout: '', stderr: '', code: 0 };
}

function runHeadTail(
  state: SimState,
  argv: string[],
  tail: boolean,
): { stdout: string; stderr: string; code: number } {
  let count = 10;
  let index = 0;
  if (argv[0] === '-n' && argv[1] !== undefined) {
    const parsed = Number(argv[1]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { stdout: '', stderr: `invalid number: ${argv[1]}`, code: 1 };
    }
    count = parsed;
    index = 2;
  }
  const operands = argv.slice(index);
  if (operands.length === 0) {
    return { stdout: '', stderr: `${tail ? 'tail' : 'head'}: missing file operand`, code: 1 };
  }
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const operand of operands) {
    const file = readFileForCommand(state, operand);
    if (typeof file === 'string') {
      stderr += `${file}\n`;
      code = 1;
      continue;
    }
    const lines = file.content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const selected = tail ? lines.slice(-count) : lines.slice(0, count);
    stdout += selected.map((line) => `${line}\n`).join('');
  }
  return { stdout, stderr, code };
}

function runGrep(
  state: SimState,
  argv: string[],
): { stdout: string; stderr: string; code: number } {
  const flags = new Set(argv.filter((token) => token.startsWith('-') && token !== '-'));
  const operands = argv.filter((token) => !token.startsWith('-') || token === '-');
  if (operands.length < 2) {
    return { stdout: '', stderr: 'grep: missing pattern or file operand', code: 1 };
  }
  const pattern = operands[0]!;
  const insensitive = flags.has('-i');
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, insensitive ? 'i' : '');
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), insensitive ? 'i' : '');
  }
  const multiple = operands.length > 2;
  let stdout = '';
  let stderr = '';
  let code = 1;
  for (const operand of operands.slice(1)) {
    const file = readFileForCommand(state, operand);
    if (typeof file === 'string') {
      stderr += `${file}\n`;
      continue;
    }
    const lines = file.content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    lines.forEach((line, lineIndex) => {
      if (!regex.test(line)) return;
      code = 0;
      const prefix = multiple ? `${operand}:` : '';
      const number = flags.has('-n') ? `${lineIndex + 1}:` : '';
      stdout += `${prefix}${number}${line}\n`;
    });
  }
  return { stdout, stderr, code };
}

function runWc(state: SimState, argv: string[]): { stdout: string; stderr: string; code: number } {
  const flags = new Set(argv.filter((token) => token.startsWith('-') && token !== '-'));
  const operands = argv.filter((token) => !token.startsWith('-') || token === '-');
  if (operands.length === 0) {
    return { stdout: '', stderr: 'wc: missing file operand', code: 1 };
  }
  const showLines = flags.size === 0 || flags.has('-l');
  const showWords = flags.size === 0 || flags.has('-w');
  const showChars = flags.size === 0 || flags.has('-c');
  const multiple = operands.length > 1;
  let stdout = '';
  let stderr = '';
  let code = 0;
  let totalLines = 0;
  let totalWords = 0;
  let totalChars = 0;
  for (const operand of operands) {
    const file = readFileForCommand(state, operand);
    if (typeof file === 'string') {
      stderr += `${file}\n`;
      code = 1;
      continue;
    }
    const lines =
      file.content === ''
        ? 0
        : file.content.split('\n').length - (file.content.endsWith('\n') ? 1 : 0);
    const words = file.content.split(/\s+/).filter(Boolean).length;
    const chars = file.content.length;
    totalLines += lines;
    totalWords += words;
    totalChars += chars;
    const fields: number[] = [];
    if (showLines) fields.push(lines);
    if (showWords) fields.push(words);
    if (showChars) fields.push(chars);
    stdout += `${fields.join(' ')}${multiple ? ` ${operand}` : ''}\n`;
  }
  if (multiple) {
    const fields: number[] = [];
    if (showLines) fields.push(totalLines);
    if (showWords) fields.push(totalWords);
    if (showChars) fields.push(totalChars);
    stdout += `${fields.join(' ')} total\n`;
  }
  return { stdout, stderr, code };
}

function runEnv(state: SimState): { stdout: string; stderr: string; code: number } {
  return {
    stdout: `${Object.keys(state.env)
      .sort()
      .map((key) => `${key}=${state.env[key]}`)
      .join('\n')}\n`,
    stderr: '',
    code: 0,
  };
}

const HELP_TEXT = [
  'Supported commands:',
  '  pwd, ls, cd, cat, echo, mkdir, touch, rm, cp, mv',
  '  head, tail, grep, wc, env, export, unset, help',
  'Redirection: > (overwrite) and >> (append).',
].join('\n');

function runCommand(state: SimState, line: string): void {
  const parsed = parseCommandLine(line, state.env);
  if (typeof parsed === 'string') {
    writeErr(state, `bash: ${parsed}`);
    state.exitCode = 2;
    return;
  }
  if (parsed.argv.length === 0) return;
  const [command, ...args] = parsed.argv;
  switch (command) {
    case 'pwd':
      emit(state, parsed, `${state.cwd}\n`, '', 0);
      return;
    case 'ls': {
      const result = runLs(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'cd':
      if (args.length > 1) {
        emit(state, parsed, '', 'cd: too many arguments', 1);
        return;
      }
      {
        const result = runCd(state, args);
        emit(state, parsed, result.stdout, result.stderr, result.code);
      }
      return;
    case 'cat': {
      const result = runCat(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'echo': {
      const noNewline = args[0] === '-n';
      const text = (noNewline ? args.slice(1) : args).join(' ');
      emit(state, parsed, `${text}${noNewline ? '' : '\n'}`, '', 0);
      return;
    }
    case 'mkdir': {
      const result = runMkdir(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'touch': {
      const result = runTouch(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'rm': {
      const result = runRm(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'cp': {
      const result = runCpMv(state, args, false);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'mv': {
      const result = runCpMv(state, args, true);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'head': {
      const result = runHeadTail(state, args, false);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'tail': {
      const result = runHeadTail(state, args, true);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'grep': {
      const result = runGrep(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'wc': {
      const result = runWc(state, args);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'env': {
      const result = runEnv(state);
      emit(state, parsed, result.stdout, result.stderr, result.code);
      return;
    }
    case 'export': {
      if (args.length === 0) {
        const result = runEnv(state);
        emit(state, parsed, result.stdout, result.stderr, result.code);
        return;
      }
      let stderr = '';
      let code = 0;
      for (const assignment of args) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(assignment);
        if (!match) {
          stderr += `export: '${assignment}': not a valid identifier\n`;
          code = 1;
          continue;
        }
        state.env[match[1]!] = expandVariables(match[2]!, state.env);
      }
      emit(state, parsed, '', stderr, code);
      return;
    }
    case 'unset': {
      for (const name of args) delete state.env[name];
      emit(state, parsed, '', '', 0);
      return;
    }
    case 'help':
      emit(state, parsed, `${HELP_TEXT}\n`, '', 0);
      return;
    default:
      emit(state, parsed, '', `bash: ${command}: command not found`, 127);
  }
}

function snapshotFiles(state: SimState): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [path, content] of state.fs.files) {
    if (path === TERMINAL_HOME) continue;
    if (path.startsWith(`${TERMINAL_HOME}/`)) {
      files[path.slice(TERMINAL_HOME.length + 1)] = content;
    }
  }
  return files;
}

function snapshotState(state: SimState): Record<string, string> {
  const snapshot: Record<string, string> = { cwd: state.cwd };
  for (const [key, value] of Object.entries(state.env)) snapshot[`env.${key}`] = value;
  return snapshot;
}

/** Run one deterministic terminal session and report its observable state. */
export function simulateTerminal(request: {
  initialFiles?: Record<string, string>;
  commands?: string[];
}): ActivityRunResult {
  const started = Date.now();
  const commands = Array.isArray(request.commands) ? request.commands : [];
  if (commands.length > MAX_COMMANDS) {
    return {
      status: 'error',
      stdout: '',
      stderr: '',
      error: `The session exceeded the ${MAX_COMMANDS}-command limit for one attempt.`,
      durationMs: Date.now() - started,
    };
  }

  const state: SimState = {
    cwd: TERMINAL_HOME,
    env: {
      HOME: TERMINAL_HOME,
      USER: 'learner',
      SHELL: '/bin/bash',
      PATH: DEFAULT_PATH,
      PWD: TERMINAL_HOME,
    },
    fs: { files: new Map(), dirs: new Set(['/', '/home', TERMINAL_HOME]) },
    stdout: '',
    stderr: '',
    exitCode: 0,
    outputChars: 0,
  };

  for (const [path, content] of Object.entries(request.initialFiles ?? {})) {
    const target = resolvePath(TERMINAL_HOME, path, state.env);
    writeFile(state, target, content, false);
  }

  for (const line of commands) {
    if (typeof line !== 'string') continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    runCommand(state, trimmed);
    if (state.outputChars > MAX_OUTPUT_CHARS) {
      return {
        status: 'error',
        stdout: '',
        stderr: '',
        error: `The session produced more than ${MAX_OUTPUT_CHARS} characters of output.`,
        durationMs: Date.now() - started,
      };
    }
    state.env.PWD = state.cwd;
  }

  return {
    status: 'ok',
    stdout: state.stdout,
    stderr: state.stderr,
    exitCode: state.exitCode,
    files: snapshotFiles(state),
    state: snapshotState(state),
    durationMs: Date.now() - started,
  };
}
