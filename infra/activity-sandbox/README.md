# Activity sandbox image

Reference image for the operator-gated server runtime (`ACTIVITY_DOCKER_IMAGE`).
It executes a list of shell commands in a disposable, network-isolated
container and returns one JSON result on stdout.

## Build

```sh
docker build -t openmaic/activity-sandbox:local infra/activity-sandbox
```

Then set, on the app server:

```sh
ACTIVITY_SERVER_RUNTIME_ENABLED=true
ACTIVITY_DOCKER_IMAGE=openmaic/activity-sandbox:local
```

Review the image before enabling the tier. The app never pulls it (`--pull
never`), never mounts a host path, never forwards host environment variables,
and always runs it with `--network none`, a read-only root filesystem, all
capabilities dropped, `no-new-privileges`, a non-root UID, and memory/CPU/PID
limits. Those flags are in `lib/activity/server/docker.ts` and are covered by
unit tests; changing them is a security review event.

## Protocol

stdin:

```json
{ "initialFiles": { "notes.txt": "hello\n" }, "commands": ["cat notes.txt"] }
```

stdout (one JSON object):

```json
{
  "status": "ok",
  "stdout": "hello\n",
  "stderr": "",
  "exitCode": 0,
  "files": { "notes.txt": "hello\n" },
  "state": { "cwd": "/home/learner", "env.HOME": "/home/learner" }
}
```

`files` keys and `state["file:..."]` paths are relative to `/home/learner`.
The session's `cd`/`export`/`unset` state is carried between commands. This is a
single-container shell, not a multi-host network lab; those need a dedicated
orchestration backend behind the same app-facing interface.
