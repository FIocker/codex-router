import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { processStartIdentity } from "./process-identity.mjs";

const WINDOWS_CODEX_PACKAGE_NAME = "OpenAI.Codex";
const WINDOWS_CODEX_PACKAGE_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";
const WINDOWS_CODEX_APP_ID = `${WINDOWS_CODEX_PACKAGE_FAMILY}!App`;
const CLIENT_STOP_TIMEOUT_MS = 15_000;
const CLIENT_GRACEFUL_STOP_MS = 5_000;
const LINUX_CODEX_EXECUTABLE_CANDIDATES = Object.freeze([
  "/usr/lib/chatgpt/ChatGPT",
]);
const LINUX_SYSTEM_EXECUTABLE_ROOTS = Object.freeze(["/usr", "/opt"]);

function powershellResult(script, { env = process.env, spawnImpl = spawnSync } = {}) {
  return spawnImpl(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env,
      timeout: CLIENT_STOP_TIMEOUT_MS,
      windowsHide: true,
    },
  );
}

function normalizeWindowsProcess(record) {
  return {
    name: String(record?.Name || record?.name || "").toLowerCase(),
    pid: Number(record?.ProcessId ?? record?.pid),
    parentPid: Number(record?.ParentProcessId ?? record?.parentPid),
    executablePath: String(record?.ExecutablePath || record?.executablePath || ""),
  };
}

export function windowsCodexProcesses(options = {}) {
  if (options.processes !== undefined) {
    return options.processes.map((record) =>
      typeof record === "string"
        ? normalizeWindowsProcess({ Name: record })
        : normalizeWindowsProcess(record),
    );
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Keep intermediate ancestors and descendants so a bundled codex.exe can
    // be distinguished from an independent CLI even when another process sits
    // between it and ChatGPT.exe.
    "$items = @(Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))",
  ].join("; ");
  const result = powershellResult(script, options);
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(String(result.stdout || "[]"));
    return (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeWindowsProcess);
  } catch {
    return undefined;
  }
}

function isCodexDesktopHost(record) {
  if (record.name !== "chatgpt.exe") return false;
  if (!record.executablePath) return false;
  const normalized = record.executablePath.replaceAll("/", "\\").toLowerCase();
  return (
    normalized.includes("\\windowsapps\\openai.codex_") &&
    normalized.endsWith("__2p2nqsd0c76g0\\app\\chatgpt.exe")
  );
}

function isCodexCli(record) {
  return record.name === "codex.exe";
}

function normalizeLinuxProcess(record, options = {}) {
  if (typeof record === "string") {
    return {
      name: path.basename(record.trim()).toLowerCase(),
      pid: undefined,
      parentPid: undefined,
      executablePath: "",
      identity: "",
      trusted: false,
    };
  }
  const executablePath = String(record?.executablePath || record?.ExecutablePath || "");
  const trustedPath =
    record?.trusted === true
      ? executablePath
      : trustedLinuxCodexExecutable(executablePath, options);
  return {
    name: String(record?.name || record?.Name || "").toLowerCase(),
    pid: Number(record?.pid ?? record?.ProcessId),
    parentPid: Number(record?.parentPid ?? record?.ParentProcessId),
    executablePath,
    identity: String(record?.identity || ""),
    trusted: Boolean(trustedPath),
  };
}

function linuxExecutableUnderSystemRoot(executablePath) {
  return LINUX_SYSTEM_EXECUTABLE_ROOTS.find((root) => {
    const relative = path.relative(root, executablePath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

// Linux does not expose a signed package family like Windows. The desktop app
// is therefore eligible for automatic lifecycle management only when its
// executable resolves inside a system prefix, is owned by root, is executable,
// and cannot be replaced by an unprivileged group or user. An AppImage or a
// same-named process under $HOME is deliberately left alone.
export function trustedLinuxCodexExecutable(candidate, options = {}) {
  if (!candidate || !path.isAbsolute(candidate)) return "";
  try {
    const resolved = (options.realpathImpl || realpathSync)(candidate);
    if (path.basename(resolved).toLowerCase() !== "chatgpt") return "";
    const systemRoot = linuxExecutableUnderSystemRoot(resolved);
    if (!systemRoot) return "";
    const approved = options.executableCandidates || LINUX_CODEX_EXECUTABLE_CANDIDATES;
    if (!approved.includes(resolved)) return "";
    const inspect = options.statImpl || statSync;
    const stat = inspect(resolved);
    if (!stat.isFile() || stat.uid !== 0) return "";
    if ((stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) return "";
    // A protected file inside a writable directory is still replaceable by
    // rename. Verify every containing directory through the filesystem root.
    for (let parent = path.dirname(resolved); ; parent = path.dirname(parent)) {
      const parentStat = inspect(parent);
      if (!parentStat.isDirectory() || parentStat.uid !== 0 || (parentStat.mode & 0o022) !== 0) {
        return "";
      }
      if (parent === path.parse(parent).root) break;
    }
    return resolved;
  } catch {
    return "";
  }
}

export function linuxCodexProcesses(options = {}) {
  if (options.processes !== undefined) {
    return options.processes.map((record) => normalizeLinuxProcess(record, options));
  }
  const result = (options.spawnSyncImpl || spawnSync)(
    "ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "comm="],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) return undefined;
  const readlink = options.readlinkImpl || readlinkSync;
  const identity = options.identityImpl || processStartIdentity;
  const records = [];
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const name = path.basename(match[3]).toLowerCase();
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    let executablePath = "";
    if (name === "chatgpt" || name === "codex") {
      try {
        executablePath = readlink(`/proc/${pid}/exe`);
      } catch {
        executablePath = "";
      }
    }
    const trustedPath =
      name === "chatgpt" ? trustedLinuxCodexExecutable(executablePath, options) : "";
    records.push({
      name,
      pid,
      parentPid,
      executablePath,
      identity:
        trustedPath || name === "codex"
          ? String(identity(pid, { platform: "linux" }) || "")
          : "",
      trusted: Boolean(trustedPath),
    });
  }
  return records;
}

function isLinuxCodexDesktopHost(record) {
  return record.name === "chatgpt" && record.trusted === true;
}

function isLinuxCodexCli(record) {
  return record.name === "codex";
}

function linuxProcessSnapshot(options = {}) {
  const raw = (options.queryProcesses || linuxCodexProcesses)(options);
  return raw === undefined
    ? undefined
    : raw.map((record) => normalizeLinuxProcess(record, options));
}

function posixProcessNames({ spawnImpl = spawnSync } = {}) {
  const result = spawnImpl("ps", ["-A", "-o", "comm="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return undefined;
  return String(result.stdout)
    .split(/\r?\n/)
    .map((line) => path.basename(line.trim()).toLowerCase())
    .filter(Boolean);
}

export function codexClientProcessStatus(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    const processes = windowsCodexProcesses(options);
    if (!processes) return { known: false, running: false };
    if (processes.some((record) => record.name === "chatgpt.exe" && !record.executablePath)) {
      return { known: false, running: false };
    }
    return {
      known: true,
      running: processes.some((record) => isCodexDesktopHost(record) || isCodexCli(record)),
    };
  }
  if (platform === "linux") {
    const processes = linuxProcessSnapshot(options);
    if (!processes) return { known: false, running: false };
    // A ChatGPT-named process whose executable cannot be verified still blocks
    // a credential swap, but it is never a process the router may signal.
    if (processes.some((record) => record.name === "chatgpt" && !record.trusted)) {
      return { known: false, running: false };
    }
    return {
      known: true,
      running: processes.some(
        (record) => isLinuxCodexDesktopHost(record) || isLinuxCodexCli(record),
      ),
    };
  }
  const names = options.processes ?? posixProcessNames(options);
  if (!names) return { known: false, running: false };
  return {
    known: true,
    running: names.some((name) => ["codex", "chatgpt"].includes(String(name).toLowerCase())),
  };
}

function rootLinuxDesktopProcesses(processes) {
  const desktop = processes.filter(isLinuxCodexDesktopHost);
  const desktopIds = new Set(desktop.map((record) => record.pid).filter(Number.isSafeInteger));
  const roots = desktop.filter(
    (record) =>
      Number.isSafeInteger(record.pid) &&
      record.pid > 0 &&
      !desktopIds.has(record.parentPid),
  );
  return roots.length
    ? roots
    : desktop.filter((record) => Number.isSafeInteger(record.pid) && record.pid > 0);
}

function linuxDesktopProcessTree(processes) {
  const roots = rootLinuxDesktopProcesses(processes);
  const memberIds = new Set(roots.map((record) => record.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of processes) {
      if (
        Number.isSafeInteger(record.pid) &&
        memberIds.has(record.parentPid) &&
        !memberIds.has(record.pid)
      ) {
        memberIds.add(record.pid);
        changed = true;
      }
    }
  }
  return processes.filter((record) => memberIds.has(record.pid));
}

function hasStandaloneLinuxCodexCli(processes) {
  const desktopMembers = new Set(
    linuxDesktopProcessTree(processes)
      .map((record) => record.pid)
      .filter(Number.isSafeInteger),
  );
  return processes.some(
    (record) => isLinuxCodexCli(record) && !desktopMembers.has(record.pid),
  );
}

export function discoverLinuxCodexLaunch(options = {}) {
  const processes = options.processes
    ? options.processes.map((record) => normalizeLinuxProcess(record, options))
    : linuxProcessSnapshot(options);
  if (!processes) return { executablePath: "" };
  for (const record of rootLinuxDesktopProcesses(processes)) {
    const trusted = trustedLinuxCodexExecutable(record.executablePath, options);
    if (trusted) return { executablePath: trusted };
  }
  for (const candidate of options.executableCandidates || LINUX_CODEX_EXECUTABLE_CANDIDATES) {
    const trusted = trustedLinuxCodexExecutable(candidate, options);
    if (trusted) return { executablePath: trusted };
  }
  return { executablePath: "" };
}

export function stopLinuxCodexDesktop(processes, options = {}) {
  const roots = rootLinuxDesktopProcesses(
    processes.map((record) => normalizeLinuxProcess(record, options)),
  );
  const kill = options.killImpl || process.kill;
  for (const target of roots) {
    if (!target.identity) {
      throw new Error("Could not verify the Codex desktop process identity; no login was changed.");
    }
    const current = linuxProcessSnapshot(options);
    if (!current) {
      throw new Error("Could not verify the Codex desktop process; no login was changed.");
    }
    const samePid = current.find((record) => record.pid === target.pid);
    if (!samePid) continue;
    if (
      !isLinuxCodexDesktopHost(samePid) ||
      samePid.identity !== target.identity ||
      samePid.executablePath !== target.executablePath
    ) {
      throw new Error("The Codex desktop process changed before it could be closed; no login was changed.");
    }
    try {
      kill(target.pid, "SIGTERM");
    } catch (error) {
      if (error?.code === "ESRCH") continue;
      const afterFailure = linuxProcessSnapshot(options);
      if (afterFailure && !afterFailure.some((record) => record.pid === target.pid)) continue;
      throw new Error("Codex could not be closed safely; no login was changed.");
    }
  }
}

function linuxDesktopSnapshotStopped(processes, stoppedProcesses = []) {
  const capturedMemberStillRunning = stoppedProcesses.some(
    (stopped) =>
      stopped.identity &&
      processes.some(
        (record) => record.pid === stopped.pid && record.identity === stopped.identity,
      ),
  );
  return (
    !processes.some(isLinuxCodexDesktopHost) &&
    !processes.some(isLinuxCodexCli) &&
    !capturedMemberStillRunning
  );
}

function linuxDesktopStoppedWithin(options, timeoutMs) {
  const now = options.nowImpl || Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const processes = linuxProcessSnapshot(options);
    if (!processes) {
      throw new Error("Could not verify that Codex closed; no login was changed.");
    }
    const stoppedProcesses = options.stoppedProcesses || [];
    if (linuxDesktopSnapshotStopped(processes, stoppedProcesses)) return true;
    (options.sleepImpl || sleep)(100);
  }
  return false;
}

function waitForLinuxDesktopToStop(options = {}) {
  if (linuxDesktopStoppedWithin(options, options.stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS)) return;
  // SIGTERM is the cooperative boundary. Never escalate an account switch
  // into a forced kill of a desktop process that may still be writing auth.
  throw new Error("Codex did not exit after the safe stop request; no login was changed.");
}

function waitForLinuxDesktopToStart(executablePath, options = {}) {
  const now = options.nowImpl || Date.now;
  const deadline = now() + (options.startTimeoutMs || CLIENT_STOP_TIMEOUT_MS);
  while (now() < deadline) {
    const processes = linuxProcessSnapshot(options);
    if (!processes) return false;
    if (
      processes.some(
        (record) =>
          isLinuxCodexDesktopHost(record) && record.executablePath === executablePath,
      )
    ) {
      return true;
    }
    (options.sleepImpl || sleep)(100);
  }
  return false;
}

export function launchLinuxCodex(launch, options = {}) {
  const executablePath = trustedLinuxCodexExecutable(launch?.executablePath, options);
  if (!executablePath) {
    throw new Error("The installed Codex desktop app could not be verified; it was not launched.");
  }
  const environment = options.env || process.env;
  const systemdRun = options.systemdRunImpl || spawnSync;
  const unitName =
    options.systemdUnitName || `codex-router-chatgpt-${randomUUID()}`;
  const systemdArguments = [
    "--user",
    "--collect",
    "--quiet",
    "--unit",
    unitName,
    "--property",
    "Type=exec",
  ];
  // A transient service inherits the user manager's environment, not
  // service-local variables from the tray. Preserve only the selected Codex
  // home; forwarding the entire tray environment would leak unrelated values.
  if (typeof environment.CODEX_HOME === "string" && environment.CODEX_HOME) {
    systemdArguments.push(`--setenv=CODEX_HOME=${environment.CODEX_HOME}`);
  }
  systemdArguments.push("--", executablePath);
  const systemd = systemdRun(
    "systemd-run",
    systemdArguments,
    { encoding: "utf8", env: environment, timeout: 5_000 },
  );
  if (systemd.status !== 0) {
    // A process detached from the tray still belongs to the tray's systemd
    // cgroup and would be killed by its next restart. Inside a managed unit,
    // refuse that unsafe fallback. A non-systemd desktop may use the ordinary
    // detached launch instead.
    if (environment.INVOCATION_ID) {
      throw new Error(
        "Codex could not be handed off to its own user service. Open it from the application menu.",
      );
    }
    const child = (options.spawnImpl || spawn)(executablePath, [], {
      cwd: path.dirname(executablePath),
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once?.("error", () => {});
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      throw new Error(
        "Codex could not be reopened automatically. Open it from the application menu.",
      );
    }
    child.unref?.();
  }
  if (!waitForLinuxDesktopToStart(executablePath, options)) {
    throw new Error(
      "Linux accepted the Codex launch, but the app could not be verified as running. Open it from the application menu.",
    );
  }
}

export function discoverWindowsCodexLaunch(options = {}) {
  const script = [
    `$expectedFamily = '${WINDOWS_CODEX_PACKAGE_FAMILY}'`,
    `$package = Get-AppxPackage -Name ${WINDOWS_CODEX_PACKAGE_NAME} | Where-Object { $_.PackageFamilyName -eq $expectedFamily } | Sort-Object Version -Descending | Select-Object -First 1`,
    "$exe = if ($package) { Join-Path $package.InstallLocation 'app\\ChatGPT.exe' } else { '' }",
    "$value = [pscustomobject]@{ PackageFamilyName = if ($package) { $package.PackageFamilyName } else { '' }; InstallLocation = if ($package) { $package.InstallLocation } else { '' }; ExecutablePath = $exe; AppId = if ($package) { $expectedFamily + '!App' } else { '' } }",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $value -Compress))",
  ].join("; ");
  const result = powershellResult(script, options);
  let discovered = {};
  if (result.status === 0) {
    try {
      discovered = JSON.parse(String(result.stdout || "{}"));
    } catch {
      discovered = {};
    }
  }
  const family = String(discovered.PackageFamilyName || "");
  const installLocation = String(discovered.InstallLocation || "");
  const candidate = String(discovered.ExecutablePath || "");
  let trustedExecutable = "";
  if (family === WINDOWS_CODEX_PACKAGE_FAMILY && installLocation && candidate) {
    const expected = path.win32.resolve(installLocation, "app", "ChatGPT.exe");
    if (expected.toLowerCase() === path.win32.resolve(candidate).toLowerCase()) {
      trustedExecutable = candidate;
    }
  }
  return {
    executablePath: trustedExecutable,
    appId:
      family === WINDOWS_CODEX_PACKAGE_FAMILY && discovered.AppId === WINDOWS_CODEX_APP_ID
        ? WINDOWS_CODEX_APP_ID
        : "",
  };
}

function rootDesktopProcessIds(processes) {
  const desktop = processes.filter(isCodexDesktopHost);
  const desktopIds = new Set(desktop.map((record) => record.pid).filter(Number.isInteger));
  const roots = desktop
    .filter((record) => Number.isInteger(record.pid) && !desktopIds.has(record.parentPid))
    .map((record) => record.pid);
  return roots.length ? roots : [...desktopIds];
}

function windowsDesktopProcessTree(processes) {
  const memberIds = new Set(rootDesktopProcessIds(processes));
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of processes) {
      if (
        Number.isSafeInteger(record.pid) &&
        memberIds.has(record.parentPid) &&
        !memberIds.has(record.pid)
      ) {
        memberIds.add(record.pid);
        changed = true;
      }
    }
  }
  return processes.filter((record) => memberIds.has(record.pid));
}

function hasStandaloneWindowsCodexCli(processes) {
  const desktopMembers = new Set(
    windowsDesktopProcessTree(processes)
      .map((record) => record.pid)
      .filter(Number.isSafeInteger),
  );
  return processes.some((record) => isCodexCli(record) && !desktopMembers.has(record.pid));
}

export function stopWindowsProcessTree(processes, options = {}) {
  const pids = rootDesktopProcessIds(processes);
  if (!pids.length) return;
  const pidArgs = pids.flatMap((pid) => ["/PID", String(pid)]);
  const spawn = options.spawnImpl || spawnSync;
  const graceful = spawn("taskkill.exe", ["/T", ...pidArgs], {
    encoding: "utf8",
    timeout: CLIENT_STOP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (graceful.status === 0 && desktopStoppedWithin(options, CLIENT_GRACEFUL_STOP_MS)) return;

  const direct = spawn("taskkill.exe", ["/F", "/T", ...pidArgs], {
    encoding: "utf8",
    timeout: CLIENT_STOP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (direct.status === 0) return;
  const afterDirect = (options.queryProcesses || windowsCodexProcesses)(options);
  if (afterDirect && !afterDirect.some(isCodexDesktopHost)) return;

  // Re-enumerate only the official Store package after the UAC prompt. PIDs
  // captured before an operator answered UAC may already belong to something
  // else by the time the elevated process starts.
  const elevatedStopScript = [
    "$ErrorActionPreference = 'Stop'",
    `$expectedFamily = '${WINDOWS_CODEX_PACKAGE_FAMILY}'`,
    `$package = Get-AppxPackage -Name ${WINDOWS_CODEX_PACKAGE_NAME} | Where-Object { $_.PackageFamilyName -eq $expectedFamily } | Sort-Object Version -Descending | Select-Object -First 1`,
    "if (-not $package) { exit 2 }",
    "$expectedExe = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation 'app\\ChatGPT.exe'))",
    "$targets = @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expectedExe })",
    "if ($targets.Count -eq 0) { exit 0 }",
    "$arguments = @('/F', '/T')",
    "$targets | ForEach-Object { $arguments += @('/PID', [string]$_.ProcessId) }",
    "$killed = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\taskkill.exe') -ArgumentList ($arguments -join ' ') -WindowStyle Hidden -Wait -PassThru",
    "exit $killed.ExitCode",
  ].join("; ");
  const encodedStopScript = Buffer.from(elevatedStopScript, "utf16le").toString("base64");
  const script = [
    "$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $env:CODEX_ROUTER_ELEVATED_STOP_SCRIPT)",
    "$process = Start-Process -FilePath 'powershell.exe' -ArgumentList ($arguments -join ' ') -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    "exit $process.ExitCode",
  ].join("; ");
  const elevated = powershellResult(script, {
    ...options,
    env: {
      ...(options.env || process.env),
      CODEX_ROUTER_ELEVATED_STOP_SCRIPT: encodedStopScript,
    },
  });
  if (elevated.status !== 0) {
    const afterElevated = (options.queryProcesses || windowsCodexProcesses)(options);
    if (afterElevated && !afterElevated.some(isCodexDesktopHost)) return;
    throw new Error("Codex could not be closed. Approve the Windows administrator prompt and try again.");
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function desktopStoppedWithin(options, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processes = (options.queryProcesses || windowsCodexProcesses)(options);
    if (!processes) throw new Error("Could not verify that Codex closed; no login was changed.");
    if (!processes.some((record) => isCodexDesktopHost(record) || isCodexCli(record))) return true;
    (options.sleepImpl || sleep)(100);
  }
  return false;
}

function waitForDesktopToStop(options = {}) {
  if (desktopStoppedWithin(options, CLIENT_STOP_TIMEOUT_MS)) return;
  throw new Error("Codex did not close in time; no login was changed.");
}

function waitForDesktopToStart(options = {}) {
  const deadline = Date.now() + CLIENT_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const processes = (options.queryProcesses || windowsCodexProcesses)(options);
    // A successful package activation is the best available signal if process
    // inspection itself becomes unavailable after launch.
    if (!processes) return true;
    if (processes.some(isCodexDesktopHost)) return true;
    // Windows can hide ExecutablePath from the non-elevated tray while the
    // freshly elevated ChatGPT process initializes. This relaxed signal is
    // used only after launching the freshly verified official Store package;
    // the pre-switch process check remains fail-closed on the same shape.
    if (
      options.trustedLaunchPending &&
      processes.some((record) => record.name === "chatgpt.exe" && !record.executablePath)
    ) {
      return true;
    }
    (options.sleepImpl || sleep)(100);
  }
  return false;
}

export function launchWindowsCodex(launch, options = {}) {
  // The AppUserModelID survives Microsoft Store version changes. Re-resolve
  // the executable only for the best-effort elevated launch, and always keep
  // the stable package activation id as the fallback.
  const fresh = discoverWindowsCodexLaunch(options);
  const resolved = {
    // Never elevate a path captured from a running process. Only a fresh
    // official package lookup is trusted across the UAC boundary.
    executablePath: fresh.executablePath,
    appId: fresh.appId || launch.appId,
  };
  const elevatedScript = [
    "$process = Start-Process -FilePath $env:CODEX_ROUTER_CODEX_EXE -WorkingDirectory (Split-Path $env:CODEX_ROUTER_CODEX_EXE) -Verb RunAs -PassThru",
    "if (-not $process) { exit 1 }",
  ].join("; ");
  if (resolved.executablePath) {
    const elevated = powershellResult(elevatedScript, {
      ...options,
      env: {
        ...(options.env || process.env),
        CODEX_ROUTER_CODEX_EXE: resolved.executablePath,
      },
    });
    if (
      elevated.status === 0 &&
      waitForDesktopToStart({ ...options, trustedLaunchPending: true })
    ) {
      return;
    }
  }

  const fallbackScript = [
    "if ($env:CODEX_ROUTER_CODEX_APP_ID) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\\' + $env:CODEX_ROUTER_CODEX_APP_ID) }",
    "elseif ($env:CODEX_ROUTER_CODEX_EXE) { Start-Process -FilePath $env:CODEX_ROUTER_CODEX_EXE -WorkingDirectory (Split-Path $env:CODEX_ROUTER_CODEX_EXE) }",
    "else { exit 1 }",
  ].join(" ");
  const fallback = powershellResult(fallbackScript, {
    ...options,
    env: {
      ...(options.env || process.env),
      CODEX_ROUTER_CODEX_APP_ID: resolved.appId,
      CODEX_ROUTER_CODEX_EXE: resolved.executablePath,
    },
  });
  if (fallback.status !== 0) {
    throw new Error("Codex could not be reopened automatically. Open it from the Start menu.");
  }
  if (!waitForDesktopToStart({ ...options, trustedLaunchPending: true })) {
    throw new Error("Windows accepted the Codex launch, but the app did not start. Open it from the Start menu.");
  }
}

async function withRestartedLinuxCodexDesktop(operation, options = {}) {
  const queryProcesses = () => linuxProcessSnapshot(options);
  const before = queryProcesses();
  if (!before) {
    throw new Error("Could not inspect the Codex desktop process; no login was changed.");
  }
  if (before.some((record) => record.name === "chatgpt" && !record.trusted)) {
    throw new Error("Could not verify the Codex desktop executable; no login was changed.");
  }
  const wasRunning = before.some(isLinuxCodexDesktopHost);
  if (hasStandaloneLinuxCodexCli(before)) {
    throw new Error("A standalone Codex CLI process is running. Close it before switching ChatGPT accounts.");
  }
  const discoverLaunch = options.discoverLaunch || discoverLinuxCodexLaunch;
  const launch = wasRunning || options.alwaysRestart
    ? discoverLaunch({ ...options, processes: before })
    : { executablePath: "" };
  if ((wasRunning || options.alwaysRestart) && !launch?.executablePath) {
    throw new Error("The installed Codex desktop app could not be found safely; no login was changed.");
  }

  let stoppedProcesses = [];
  let clientStopped = !wasRunning;
  let operationError;
  let result;
  try {
    if (wasRunning) {
      stoppedProcesses = linuxDesktopProcessTree(before);
      (options.stopImpl || stopLinuxCodexDesktop)(before, {
        ...options,
        queryProcesses,
      });
      waitForLinuxDesktopToStop({ ...options, queryProcesses, stoppedProcesses });
      clientStopped = true;
    }
    result = await operation();
  } catch (error) {
    operationError = error;
    if (!clientStopped) {
      const afterFailure = queryProcesses();
      clientStopped = Boolean(
        afterFailure && linuxDesktopSnapshotStopped(afterFailure, stoppedProcesses),
      );
    }
  }

  let restartError;
  if (clientStopped && (wasRunning || (options.alwaysRestart && !operationError))) {
    try {
      const current = queryProcesses();
      if (!current) {
        throw new Error("Could not verify whether Codex restarted.");
      }
      if (current.some((record) => record.name === "chatgpt" && !record.trusted)) {
        throw new Error("An unverifiable ChatGPT process appeared while Codex was closed.");
      }
      if (!current.some(isLinuxCodexDesktopHost)) {
        (options.startImpl || launchLinuxCodex)(launch, {
          ...options,
          queryProcesses,
        });
      }
    } catch (error) {
      restartError = error;
    }
  }
  if (operationError) {
    if (restartError) {
      throw new Error(`${operationError.message} Codex also could not be reopened automatically.`);
    }
    throw operationError;
  }
  if (restartError) {
    throw new Error(
      "The OpenAI account was switched, but Codex could not be reopened automatically. Open it from the application menu.",
    );
  }
  return result;
}

async function withRestartedWindowsCodexDesktop(operation, options = {}) {
  const queryProcesses = options.queryProcesses || windowsCodexProcesses;
  const before = queryProcesses(options);
  if (!before) throw new Error("Could not inspect the Codex desktop process; no login was changed.");
  if (before.some((record) => record.name === "chatgpt.exe" && !record.executablePath)) {
    throw new Error("Could not verify the Codex desktop executable; no login was changed.");
  }
  const wasRunning = before.some(isCodexDesktopHost);
  if (hasStandaloneWindowsCodexCli(before)) {
    throw new Error("A standalone Codex CLI process is running. Close it before switching ChatGPT accounts.");
  }
  const discoverLaunch = options.discoverLaunch || discoverWindowsCodexLaunch;
  const launch = wasRunning || options.alwaysRestart
    ? discoverLaunch(options)
    : { executablePath: "", appId: "" };
  if ((wasRunning || options.alwaysRestart) && !launch?.executablePath && !launch?.appId) {
    throw new Error("The installed Codex desktop app could not be found; no login was changed.");
  }

  let clientStopped = !wasRunning;
  let operationError;
  let result;
  try {
    if (wasRunning) {
      (options.stopImpl || stopWindowsProcessTree)(before, options);
      waitForDesktopToStop({ ...options, queryProcesses });
      clientStopped = true;
    }
    result = await operation();
  } catch (error) {
    operationError = error;
    if (!clientStopped) {
      const afterFailure = queryProcesses(options);
      clientStopped = Boolean(
        afterFailure &&
        !afterFailure.some((record) => isCodexDesktopHost(record) || isCodexCli(record)),
      );
    }
  }

  let restartError;
  if (clientStopped && (wasRunning || (options.alwaysRestart && !operationError))) {
    try {
      (options.startImpl || launchWindowsCodex)(launch, options);
    } catch (error) {
      restartError = error;
    }
  }
  if (operationError) {
    if (restartError) {
      throw new Error(`${operationError.message} Codex also could not be reopened automatically.`);
    }
    throw operationError;
  }
  if (restartError) {
    throw new Error("The OpenAI account was switched, but Codex could not be reopened automatically. Open it from the Start menu.");
  }
  return result;
}

export async function withRestartedCodexDesktop(operation, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "linux") return withRestartedLinuxCodexDesktop(operation, options);
  if (platform === "win32") return withRestartedWindowsCodexDesktop(operation, options);
  return operation();
}
