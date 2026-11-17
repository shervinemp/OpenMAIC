"""Deterministic-ish single-container shell for the activity server runtime.

Reads one JSON request from stdin, seeds the learner's home directory, runs the
commands in order, and writes one JSON result to stdout. This process is the
container's entrypoint; the container itself is the isolation boundary (no
network, read-only root, dropped capabilities), configured by the app.
"""

import json
import os
import shlex
import shutil
import signal
import subprocess
import sys

HOME = "/home/learner"
MAX_OUTPUT = 512_000
MAX_FILES = 200
MAX_FILE_BYTES = 1_048_576


def fail(message):
    print(
        json.dumps(
            {
                "status": "error",
                "stdout": "",
                "stderr": "",
                "error": message,
                "files": {},
                "state": {"cwd": HOME},
            }
        )
    )
    sys.exit(0)


def safe_relative(path):
    if not isinstance(path, str) or not path or path.startswith("/") or "\\" in path:
        return None
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return path


def seed_files(files):
    total = 0
    written = 0
    for path, content in files.items():
        relative = safe_relative(path)
        if relative is None or not isinstance(content, str):
            fail("invalid seeded file")
        target = os.path.join(HOME, relative)
        parent = os.path.dirname(target)
        os.makedirs(parent, exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(content)
        total += len(content.encode("utf-8")) + len(relative)
        written += 1
        if written > MAX_FILES or total > MAX_FILE_BYTES:
            fail("seeded files exceed the sandbox limit")


def snapshot_files():
    files = {}
    for root, dirs, names in os.walk(HOME):
        dirs[:] = [name for name in dirs if name != "__pycache__"]
        for name in names:
            full = os.path.join(root, name)
            relative = os.path.relpath(full, HOME).replace(os.sep, "/")
            if relative.startswith(".."):
                continue
            try:
                with open(full, "r", encoding="utf-8") as handle:
                    files[relative] = handle.read()
            except (UnicodeDecodeError, OSError):
                continue
    return files


def main():
    try:
        request = json.load(sys.stdin)
    except Exception:
        fail("request is not valid JSON")
    if not isinstance(request, dict):
        fail("request must be a JSON object")

    initial_files = request.get("initialFiles") or {}
    commands = request.get("commands") or []
    if not isinstance(initial_files, dict) or not isinstance(commands, list):
        fail("initialFiles must be an object and commands an array")

    os.makedirs(HOME, exist_ok=True)
    os.chdir(HOME)
    try:
        seed_files(initial_files)
    except Exception as error:
        fail(f"could not seed files: {error}")

    env = {
        "HOME": HOME,
        "USER": "learner",
        "SHELL": "/bin/sh",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PWD": HOME,
        "LANG": "C.UTF-8",
    }
    cwd = HOME
    stdout_chunks = []
    stderr_chunks = []
    total = 0
    exit_code = 0

    for raw in commands:
        if not isinstance(raw, str):
            continue
        command = raw.strip()
        if not command or command.startswith("#"):
            continue

        # Persistent shell state: emulate the two builtins a lesson relies on
        # (cd/export) and run everything else in a fresh shell at that cwd.
        try:
            words = shlex.split(command)
        except ValueError:
            stderr_chunks.append("bash: syntax error: unmatched quote\n")
            exit_code = 2
            continue
        if words and words[0] == "cd":
            target = words[1] if len(words) > 1 else HOME
            if target == "~":
                target = HOME
            elif target.startswith("~/"):
                target = HOME + target[1:]
            candidate = os.path.normpath(os.path.join(cwd, target))
            if not candidate.startswith(HOME) and candidate != HOME:
                stderr_chunks.append(f"cd: {target}: No such directory\n")
                exit_code = 1
                continue
            if not os.path.isdir(candidate):
                stderr_chunks.append(f"cd: {target}: No such directory\n")
                exit_code = 1
                continue
            cwd = candidate
            env["PWD"] = cwd
            continue
        if words and words[0] == "export" and len(words) > 1:
            for assignment in words[1:]:
                if "=" in assignment:
                    key, value = assignment.split("=", 1)
                    if key.isidentifier():
                        env[key] = value
            continue
        if words and words[0] == "unset":
            for key in words[1:]:
                env.pop(key, None)
            continue

        try:
            process = subprocess.Popen(
                ["/bin/sh", "-c", command],
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            out, err = process.communicate(timeout=15)
            exit_code = process.returncode or 0
            out_text = out.decode("utf-8", "replace")
            err_text = err.decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except Exception:
                pass
            process.communicate()
            stderr_chunks.append("bash: command timed out\n")
            exit_code = 124
            break
        except Exception as error:
            stderr_chunks.append(f"bash: {error}\n")
            exit_code = 1
            continue

        stdout_chunks.append(out_text)
        stderr_chunks.append(err_text)
        total += len(out_text) + len(err_text)
        if total > MAX_OUTPUT:
            fail("session output exceeded the sandbox limit")

    stdout = "".join(stdout_chunks)
    stderr = "".join(stderr_chunks)
    state = {"cwd": cwd}
    for key, value in env.items():
        state[f"env.{key}"] = value

    print(
        json.dumps(
            {
                "status": "ok",
                "stdout": stdout,
                "stderr": stderr,
                "exitCode": exit_code,
                "files": snapshot_files(),
                "state": state,
            }
        )
    )


if __name__ == "__main__":
    main()
