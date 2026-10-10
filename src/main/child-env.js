/**
 * A minimal environment for the helper processes this app spawns.
 *
 * Windows caps a child process's environment block at 32 KB. An app launched
 * from a shell that carries a large environment (CI runners, IDE terminals,
 * sandboxes) can exceed that, and `CreateProcess` then fails with
 * "环境块的长度为 N 个字节" — which is exactly what happens to the pointer
 * hook when it is spawned with `process.env` inherited verbatim.
 *
 * Only the variables PowerShell and the .NET runtime actually need are
 * forwarded, which keeps the block comfortably small on every machine.
 */

const FORWARDED = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "PATH",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PSModulePath",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
  "LANG",
  "LC_ALL",
];

function childEnv() {
  const env = {};
  for (const key of FORWARDED) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

module.exports = { childEnv, FORWARDED };
