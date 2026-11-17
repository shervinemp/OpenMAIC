import { describe, expect, it } from 'vitest';
import { simulateTerminal } from '@/lib/activity/terminal-simulator';
import { createTerminalRunner, TerminalRunner } from '@/lib/activity/terminal-runner';

function run(commands: string[], initialFiles: Record<string, string> = {}) {
  return simulateTerminal({ commands, initialFiles });
}

describe('simulateTerminal — navigation and files', () => {
  it('starts in the learner home with a usable environment', () => {
    const result = run(['pwd', 'echo $HOME', 'env']);
    expect(result.status).toBe('ok');
    expect(result.stdout).toContain('/home/learner\n/home/learner\n');
    expect(result.stdout).toContain('HOME=/home/learner');
    expect(result.state?.cwd).toBe('/home/learner');
  });

  it('lists, creates, reads, copies, moves and removes files', () => {
    const result = run([
      'mkdir notes',
      'echo first > notes/a.txt',
      'echo second >> notes/a.txt',
      'cat notes/a.txt',
      'cp notes/a.txt copy.txt',
      'mv copy.txt moved.txt',
      'ls',
      'ls notes',
      'rm moved.txt',
      'ls',
    ]);
    expect(result.stdout).toBe('first\nsecond\nmoved.txt\nnotes\na.txt\nnotes\n');
    expect(result.files).toEqual({ 'notes/a.txt': 'first\nsecond\n' });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('changes directory and resolves relative and parent paths', () => {
    const result = run(['cd docs', 'pwd', 'cd ..', 'pwd', 'cd /', 'pwd', 'cd ~', 'pwd'], {
      'docs/readme.txt': 'hi\n',
    });
    expect(result.stdout).toBe('/home/learner/docs\n/home/learner\n/\n/home/learner\n');
    expect(result.state?.cwd).toBe('/home/learner');
  });

  it('fails unknown commands and missing paths without aborting the session', () => {
    const result = run(['nope', 'cat missing.txt', 'echo still-here']);
    expect(result.stderr).toContain('bash: nope: command not found');
    expect(result.stderr).toContain("cannot open 'missing.txt'");
    expect(result.stdout).toBe('still-here\n');
    expect(result.exitCode).toBe(0);
  });

  it('refuses redirection into a missing directory', () => {
    const result = run(['echo hi > missing/out.txt']);
    expect(result.stderr).toContain('No such file or directory');
    expect(result.files).toEqual({});
  });

  it('does not create parents for touch or non-recursive mkdir', () => {
    const result = run(['touch a/missing.txt', 'mkdir a/b']);
    expect(result.stderr).toContain('touch: cannot touch');
    expect(result.stderr).toContain('mkdir: cannot create directory');
    expect(result.files).toEqual({});
  });

  it('supports recursive mkdir and rm', () => {
    const result = run([
      'mkdir -p a/b/c',
      'echo deep > a/b/c/file.txt',
      'ls a/b/c',
      'rm -r a',
      'ls',
    ]);
    expect(result.stdout).toBe('file.txt\n');
    expect(result.files).toEqual({});
  });
});

describe('simulateTerminal — text tools and environment', () => {
  const files = {
    'notes.txt': 'alpha\nbeta\nALPHA\n',
    'data.txt': 'one two\nthree\n',
  };

  it('heads, tails, greps and counts files', () => {
    const result = run(
      [
        'head -n 2 notes.txt',
        'tail -n 1 notes.txt',
        'grep -i alpha notes.txt',
        'grep -n beta notes.txt',
        'wc -l notes.txt',
      ],
      files,
    );
    expect(result.stdout).toBe('alpha\nbeta\nALPHA\nalpha\nALPHA\n2:beta\n3\n');
  });

  it('exports, expands and unsets environment variables', () => {
    const result = run([
      'export GREETING="hello world"',
      'echo "$GREETING"',
      'echo $HOME/notes.txt',
      'unset GREETING',
      'echo "x$GREETING"',
    ]);
    expect(result.stdout).toBe('hello world\n/home/learner/notes.txt\nx\n');
    expect(result.state?.['env.GREETING']).toBeUndefined();
  });

  it('keeps single-quoted variables literal', () => {
    expect(run(["echo '$HOME'"]).stdout).toBe('$HOME\n');
  });

  it('supports -a and -l listings', () => {
    const result = run(['touch .hidden', 'ls', 'ls -a', 'ls -l notes.txt'], files);
    expect(result.stdout).toBe(
      'data.txt\nnotes.txt\n.\n..\n.hidden\ndata.txt\nnotes.txt\n-rw-r--r-- 1 learner learner 17 notes.txt\n',
    );
  });
});

describe('simulateTerminal — limits and state', () => {
  it('reports an error instead of truncating an oversized session', () => {
    const result = simulateTerminal({ commands: Array(501).fill('pwd') });
    expect(result.status).toBe('error');
    expect(result.error).toContain('command limit');
  });

  it('captures cwd, env and HOME-relative files in the final snapshot', () => {
    const result = run(['mkdir work', 'cd work', 'export MODE=lab', 'echo done > result.txt']);
    expect(result.state).toMatchObject({
      cwd: '/home/learner/work',
      'env.MODE': 'lab',
    });
    expect(result.files).toEqual({ 'work/result.txt': 'done\n' });
  });

  it('ignores blank lines and comments', () => {
    const result = run(['', '   ', '# a comment', 'echo ok']);
    expect(result.stdout).toBe('ok\n');
  });
});

describe('TerminalRunner', () => {
  it('runs terminal requests and refuses other kinds', async () => {
    const runner = createTerminalRunner();
    expect(runner).toBeInstanceOf(TerminalRunner);
    await expect(
      runner.run({ kind: 'terminal', timeLimitMs: 5000, commands: ['pwd'] }),
    ).resolves.toMatchObject({ status: 'ok', stdout: '/home/learner\n' });
    await expect(
      runner.run({ kind: 'sql', timeLimitMs: 5000, submissionSql: 'select 1' }),
    ).resolves.toMatchObject({ status: 'error' });
    runner.dispose();
  });
});
