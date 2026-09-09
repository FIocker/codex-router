import assert from "node:assert/strict";
import test from "node:test";

import {
  codexClientProcessStatus,
  discoverLinuxCodexLaunch,
  discoverWindowsCodexLaunch,
  launchLinuxCodex,
  launchWindowsCodex,
  stopLinuxCodexDesktop,
  stopWindowsProcessTree,
  trustedLinuxCodexExecutable,
  withRestartedCodexDesktop,
} from "../src/codex-desktop-lifecycle.mjs";

const host = {
  name: "chatgpt.exe",
  pid: 123,
  parentPid: 1,
  executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe",
};

const linuxExecutable = "/usr/lib/chatgpt/ChatGPT";
const linuxHost = {
  name: "chatgpt",
  pid: 234,
  parentPid: 1,
  executablePath: linuxExecutable,
  identity: "Tue Aug 25 10:51:41 2026 ChatGPT",
  trusted: true,
};
const linuxRenderer = {
  ...linuxHost,
  pid: 235,
  parentPid: linuxHost.pid,
  identity: "Tue Aug 25 10:51:42 2026 ChatGPT",
};
const linuxAppServer = {
  name: "codex",
  pid: 236,
  parentPid: linuxHost.pid,
  executablePath: "/usr/lib/chatgpt/resources/codex",
  identity: "Tue Aug 25 10:51:43 2026 codex",
  trusted: false,
};

const trustedLinuxFilesystem = {
  realpathImpl: (candidate) => candidate,
  statImpl: (candidate) => ({
    isFile: () => candidate === linuxExecutable,
    isDirectory: () => candidate !== linuxExecutable,
    uid: 0,
    mode: 0o100755,
  }),
};

test("Linux trusts only a protected system ChatGPT executable", () => {
  assert.equal(
    trustedLinuxCodexExecutable(linuxExecutable, trustedLinuxFilesystem),
    linuxExecutable,
  );
  assert.equal(
    trustedLinuxCodexExecutable("/home/ann/ChatGPT", trustedLinuxFilesystem),
    "",
  );
  assert.equal(
    trustedLinuxCodexExecutable(linuxExecutable, {
      ...trustedLinuxFilesystem,
      statImpl: () => ({
        isFile: () => true,
        isDirectory: () => true,
        uid: 1000,
        mode: 0o100755,
      }),
    }),
    "",
  );
  assert.equal(
    trustedLinuxCodexExecutable(linuxExecutable, {
      ...trustedLinuxFilesystem,
      statImpl: () => ({
        isFile: () => true,
        isDirectory: () => true,
        uid: 0,
        mode: 0o100775,
      }),
    }),
    "",
  );
  assert.equal(
    trustedLinuxCodexExecutable(linuxExecutable, {
      ...trustedLinuxFilesystem,
      statImpl: (candidate) => ({
        isFile: () => candidate === linuxExecutable,
        isDirectory: () => candidate !== linuxExecutable,
        uid: 0,
        mode: candidate === "/usr/lib/chatgpt" ? 0o40775 : 0o40755,
      }),
    }),
    "",
    "a writable containing directory makes the executable replaceable",
  );
});

test("Linux process detection blocks unverifiable ChatGPT without treating it as a stop target", () => {
  assert.deepEqual(
    codexClientProcessStatus({ platform: "linux", processes: [linuxHost] }),
    { known: true, running: true },
  );
  assert.deepEqual(
    codexClientProcessStatus({
      platform: "linux",
      processes: [{ ...linuxHost, executablePath: "/tmp/ChatGPT", trusted: false }],
    }),
    { known: false, running: false },
  );
  assert.deepEqual(
    codexClientProcessStatus({ platform: "linux", processes: ["codex"] }),
    { known: true, running: true },
  );
});

test("Linux launch discovery resolves the verified system executable", () => {
  assert.deepEqual(
    discoverLinuxCodexLaunch({
      ...trustedLinuxFilesystem,
      processes: [linuxHost, linuxRenderer],
    }),
    { executablePath: linuxExecutable },
  );
  assert.deepEqual(
    discoverLinuxCodexLaunch({
      ...trustedLinuxFilesystem,
      processes: [],
      executableCandidates: ["/home/ann/ChatGPT"],
    }),
    { executablePath: "" },
  );
});

test("Linux stop signals only the verified desktop root", () => {
  const signals = [];
  stopLinuxCodexDesktop([linuxHost, linuxRenderer], {
    queryProcesses: () => [linuxHost, linuxRenderer],
    killImpl: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(signals, [[linuxHost.pid, "SIGTERM"]]);
});

test("Linux stop ignores invalid process identifiers", () => {
  const signals = [];
  const invalid = [
    { ...linuxHost, pid: 0, parentPid: 0 },
    { ...linuxHost, pid: -7, parentPid: -7 },
  ];
  stopLinuxCodexDesktop(invalid, {
    queryProcesses: () => invalid,
    killImpl: (pid, signal) => signals.push([pid, signal]),
  });
  assert.deepEqual(signals, []);
});

test("Linux stop refuses a recycled PID before signaling", () => {
  let signals = 0;
  assert.throws(
    () =>
      stopLinuxCodexDesktop([linuxHost], {
        queryProcesses: () => [{ ...linuxHost, identity: "new process identity" }],
        killImpl: () => {
          signals += 1;
        },
      }),
    /process changed/i,
  );
  assert.equal(signals, 0);
});

test("the Linux client cycle stops, swaps, and relaunches in order", async () => {
  let running = true;
  const events = [];
  const result = await withRestartedCodexDesktop(
    async (context) => {
      events.push("operation");
      assert.equal(running, false);
      assert.deepEqual(context, { desktopStopped: true });
      return "done";
    },
    {
      platform: "linux",
      queryProcesses: () => (running ? [linuxHost, linuxRenderer] : []),
      discoverLaunch: () => {
        events.push("discover");
        return { executablePath: linuxExecutable };
      },
      stopImpl: () => {
        events.push("stop");
        running = false;
      },
      startImpl: () => {
        events.push("start");
        running = true;
      },
    },
  );
  assert.equal(result, "done");
  assert.deepEqual(events, ["discover", "stop", "operation", "start"]);
});

test("Linux restores a previously running client when the protected operation fails", async () => {
  let running = true;
  let restarted = false;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        throw new Error("profile validation failed");
      },
      {
        platform: "linux",
        queryProcesses: () => (running ? [linuxHost] : []),
        discoverLaunch: () => ({ executablePath: linuxExecutable }),
        stopImpl: () => {
          running = false;
        },
        startImpl: () => {
          restarted = true;
          running = true;
        },
      },
    ),
    /profile validation failed/,
  );
  assert.equal(restarted, true);
});

test("Linux never force-kills a desktop that ignores the safe stop request", async () => {
  let clock = 0;
  const signals = [];
  await assert.rejects(
    withRestartedCodexDesktop(async () => "never reached", {
      platform: "linux",
      queryProcesses: () => [linuxHost],
      discoverLaunch: () => ({ executablePath: linuxExecutable }),
      killImpl: (pid, signal) => signals.push([pid, signal]),
      nowImpl: () => clock++,
      sleepImpl: () => {},
      stopTimeoutMs: 2,
    }),
    /did not exit after the safe stop request/i,
  );
  assert.deepEqual(signals, [[linuxHost.pid, "SIGTERM"]]);
});

test("Linux does not relaunch while a captured desktop helper is still running", async () => {
  let processes = [linuxHost, linuxAppServer];
  let clock = 0;
  let starts = 0;
  await assert.rejects(
    withRestartedCodexDesktop(async () => "never reached", {
      platform: "linux",
      queryProcesses: () => processes,
      discoverLaunch: () => ({ executablePath: linuxExecutable }),
      stopImpl: () => {
        processes = [linuxAppServer];
      },
      startImpl: () => {
        starts += 1;
      },
      nowImpl: () => clock++,
      sleepImpl: () => {},
      stopTimeoutMs: 2,
    }),
    /did not exit after the safe stop request/i,
  );
  assert.equal(starts, 0);
});

test("Linux does not duplicate a desktop that restarted during a failed switch", async () => {
  let running = true;
  let starts = 0;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        running = true;
        throw new Error("Codex restarted while the account switch was prepared");
      },
      {
        platform: "linux",
        queryProcesses: () => (running ? [linuxHost] : []),
        discoverLaunch: () => ({ executablePath: linuxExecutable }),
        stopImpl: () => {
          running = false;
        },
        startImpl: () => {
          starts += 1;
        },
      },
    ),
    /restarted while/i,
  );
  assert.equal(starts, 0);
});

test("Linux launches a closed client only after a successful tray switch", async () => {
  let starts = 0;
  await withRestartedCodexDesktop(async () => "done", {
    platform: "linux",
    alwaysRestart: true,
    queryProcesses: () => [],
    discoverLaunch: () => ({ executablePath: linuxExecutable }),
    startImpl: () => {
      starts += 1;
    },
  });
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        throw new Error("profile validation failed");
      },
      {
        platform: "linux",
        alwaysRestart: true,
        queryProcesses: () => [],
        discoverLaunch: () => ({ executablePath: linuxExecutable }),
        startImpl: () => {
          starts += 1;
        },
      },
    ),
    /profile validation failed/,
  );
  assert.equal(starts, 1);
});

test("Linux detached launch is verified against the exact executable", () => {
  let running = false;
  let spawnCall;
  let unref = false;
  launchLinuxCodex(
    { executablePath: linuxExecutable },
    {
      ...trustedLinuxFilesystem,
      env: {},
      systemdRunImpl: () => ({ status: 1, error: { code: "ENOENT" } }),
      spawnImpl: (command, args, options) => {
        spawnCall = { command, args, options };
        running = true;
        return {
          pid: 999,
          once: () => {},
          unref: () => {
            unref = true;
          },
        };
      },
      queryProcesses: () => (running ? [linuxHost] : []),
    },
  );
  assert.equal(spawnCall.command, linuxExecutable);
  assert.deepEqual(spawnCall.args, []);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.stdio, "ignore");
  assert.equal(unref, true);
});

test("Linux relaunch escapes a managed tray cgroup through user systemd", () => {
  let systemdCall;
  launchLinuxCodex(
    { executablePath: linuxExecutable },
    {
      ...trustedLinuxFilesystem,
      env: {
        INVOCATION_ID: "tray-unit",
        CODEX_HOME: "/srv/codex-profile",
        UNRELATED_SECRET: "must-not-be-forwarded",
      },
      systemdUnitName: "codex-router-chatgpt-test",
      systemdRunImpl: (command, args, options) => {
        systemdCall = { command, args, options };
        return { status: 0 };
      },
      spawnImpl: () => {
        throw new Error("the cgroup-unsafe fallback must not run");
      },
      queryProcesses: () => [linuxHost],
    },
  );
  assert.equal(systemdCall.command, "systemd-run");
  assert.deepEqual(systemdCall.args.slice(0, 7), [
    "--user",
    "--collect",
    "--quiet",
    "--unit",
    "codex-router-chatgpt-test",
    "--property",
    "Type=exec",
  ]);
  assert.equal(systemdCall.args.at(-2), "--");
  assert.equal(systemdCall.args.at(-1), linuxExecutable);
  assert.ok(systemdCall.args.includes("--setenv=CODEX_HOME=/srv/codex-profile"));
  assert.ok(systemdCall.args.every((argument) => !argument.includes("UNRELATED_SECRET")));
});

test("Linux refuses to relaunch beside a ChatGPT process that appeared unverifiable", async () => {
  let processes = [linuxHost];
  let starts = 0;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        processes = [
          {
            ...linuxHost,
            pid: 999,
            executablePath: "/tmp/ChatGPT",
            trusted: false,
          },
        ];
      },
      {
        platform: "linux",
        queryProcesses: () => processes,
        discoverLaunch: () => ({ executablePath: linuxExecutable }),
        stopImpl: () => {
          processes = [];
        },
        startImpl: () => {
          starts += 1;
        },
      },
    ),
    /account was switched.*could not be reopened/i,
  );
  assert.equal(starts, 0);
});

test("Linux refuses an unverified launcher before stopping or changing credentials", async () => {
  let stopped = false;
  let operated = false;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        operated = true;
      },
      {
        platform: "linux",
        queryProcesses: () => [linuxHost],
        discoverLaunch: () => ({ executablePath: "" }),
        stopImpl: () => {
          stopped = true;
        },
      },
    ),
    /could not be found safely/i,
  );
  assert.equal(stopped, false);
  assert.equal(operated, false);
});

test("Linux leaves a closed desktop closed and does not require launch discovery", async () => {
  let discovered = false;
  const result = await withRestartedCodexDesktop(async () => "done", {
    platform: "linux",
    queryProcesses: () => [],
    discoverLaunch: () => {
      discovered = true;
      return { executablePath: "" };
    },
  });
  assert.equal(result, "done");
  assert.equal(discovered, false);
});

test("Linux refuses to switch while a standalone Codex CLI is running", async () => {
  let operated = false;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        operated = true;
      },
      {
        platform: "linux",
        queryProcesses: () => [{ ...linuxAppServer, parentPid: 1 }],
      },
    ),
    /standalone Codex CLI/i,
  );
  assert.equal(operated, false);
});

test("Linux recognizes a bundled Codex CLI through an intermediate process", async () => {
  let processes = [
    linuxHost,
    { name: "node", pid: 240, parentPid: linuxHost.pid, executablePath: "/usr/bin/node" },
    { ...linuxAppServer, parentPid: 240 },
  ];
  let operated = false;
  await withRestartedCodexDesktop(
    async () => {
      operated = true;
    },
    {
      platform: "linux",
      queryProcesses: () => processes,
      discoverLaunch: () => ({ executablePath: linuxExecutable }),
      stopImpl: () => {
        processes = [];
      },
      startImpl: () => {
        processes = [linuxHost];
      },
    },
  );
  assert.equal(operated, true);
});

test("the Windows client cycle stops before work and restarts afterward", async () => {
  let running = true;
  const events = [];
  const result = await withRestartedCodexDesktop(
    async () => {
      events.push("operation");
      assert.equal(running, false);
      return "done";
    },
    {
      platform: "win32",
      queryProcesses: () => (running ? [host] : []),
      discoverLaunch: () => ({ executablePath: host.executablePath, appId: "OpenAI.Codex_pub!App" }),
      stopImpl: () => {
        events.push("stop");
        running = false;
      },
      startImpl: (launch) => {
        events.push(`start:${launch.appId}`);
        running = true;
      },
    },
  );

  assert.equal(result, "done");
  assert.deepEqual(events, ["stop", "operation", "start:OpenAI.Codex_pub!App"]);
});

test("the Windows client is restarted even when the protected operation fails", async () => {
  let running = true;
  let restarted = false;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        throw new Error("profile validation failed");
      },
      {
        platform: "win32",
        queryProcesses: () => (running ? [host] : []),
        discoverLaunch: () => ({ executablePath: host.executablePath, appId: "OpenAI.Codex_pub!App" }),
        stopImpl: () => {
          running = false;
        },
        startImpl: () => {
          restarted = true;
          running = true;
        },
      },
    ),
    /profile validation failed/,
  );
  assert.equal(restarted, true);
});

test("an already closed client can still be launched after a tray switch", async () => {
  let starts = 0;
  await withRestartedCodexDesktop(async () => "done", {
    platform: "win32",
    alwaysRestart: true,
    queryProcesses: () => [],
    discoverLaunch: () => ({ executablePath: "", appId: "OpenAI.Codex_pub!App" }),
    startImpl: () => {
      starts += 1;
    },
  });
  assert.equal(starts, 1);
});

test("a failed switch does not open a client that was already closed", async () => {
  let starts = 0;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        throw new Error("profile validation failed");
      },
      {
        platform: "win32",
        alwaysRestart: true,
        queryProcesses: () => [],
        discoverLaunch: () => ({ executablePath: "", appId: "OpenAI.Codex_pub!App" }),
        startImpl: () => {
          starts += 1;
        },
      },
    ),
    /profile validation failed/,
  );
  assert.equal(starts, 0);
});

test("Windows leaves a closed desktop closed and does not require package discovery", async () => {
  let discovered = false;
  const result = await withRestartedCodexDesktop(async () => "done", {
    platform: "win32",
    queryProcesses: () => [],
    discoverLaunch: () => {
      discovered = true;
      return { executablePath: "", appId: "" };
    },
  });
  assert.equal(result, "done");
  assert.equal(discovered, false);
});

test("Windows refuses to switch while a standalone Codex CLI is running", async () => {
  let operated = false;
  await assert.rejects(
    withRestartedCodexDesktop(
      async () => {
        operated = true;
      },
      {
        platform: "win32",
        queryProcesses: () => [{
          name: "codex.exe",
          pid: 456,
          parentPid: 1,
          executablePath: "C:\\Users\\ann\\AppData\\Roaming\\npm\\codex.exe",
        }],
      },
    ),
    /standalone Codex CLI/i,
  );
  assert.equal(operated, false);
});

test("Windows recognizes a bundled Codex CLI through an intermediate process", async () => {
  let processes = [
    host,
    { name: "node.exe", pid: 455, parentPid: host.pid, executablePath: "C:\\Program Files\\nodejs\\node.exe" },
    { name: "codex.exe", pid: 456, parentPid: 455, executablePath: "C:\\Program Files\\OpenAI\\codex.exe" },
  ];
  let operated = false;
  await withRestartedCodexDesktop(
    async () => {
      operated = true;
    },
    {
      platform: "win32",
      queryProcesses: () => processes,
      discoverLaunch: () => ({ executablePath: host.executablePath, appId: "OpenAI.Codex_pub!App" }),
      stopImpl: () => {
        processes = [];
      },
      startImpl: () => {
        processes = [host];
      },
    },
  );
  assert.equal(operated, true);
});

test("Store package discovery uses a stable AppUserModelID", () => {
  let command = "";
  const launch = discoverWindowsCodexLaunch({
    spawnImpl: (_file, args) => {
      command = args.at(-1);
      return {
        status: 0,
        stdout: JSON.stringify({
          PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
          InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99",
          ExecutablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99\\app\\ChatGPT.exe",
          AppId: "OpenAI.Codex_2p2nqsd0c76g0!App",
        }),
      };
    },
  });
  assert.equal(launch.appId, "OpenAI.Codex_2p2nqsd0c76g0!App");
  assert.match(command, /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(command, /OpenAI\.Codex_2p2nqsd0c76g0/);
  assert.doesNotMatch(command, /26\.818\.5229/);
});

test("package discovery rejects an executable from another publisher family", () => {
  const launch = discoverWindowsCodexLaunch({
    spawnImpl: () => ({
      status: 0,
      stdout: JSON.stringify({
        PackageFamilyName: "OpenAI.Codex_attacker",
        InstallLocation: "C:\\Users\\ann\\OpenAI.Codex_attacker",
        ExecutablePath: "C:\\Users\\ann\\OpenAI.Codex_attacker\\app\\ChatGPT.exe",
        AppId: "OpenAI.Codex_attacker!App",
      }),
    }),
  });
  assert.deepEqual(launch, { executablePath: "", appId: "" });
});

test("package discovery never falls back to a process-derived executable", () => {
  const launch = discoverWindowsCodexLaunch({
    processes: [host],
    spawnImpl: () => ({ status: 1, stdout: "" }),
  });
  assert.deepEqual(launch, { executablePath: "", appId: "" });
});

test("a trusted launch accepts an elevated ChatGPT process with a hidden path", () => {
  const official = {
    PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99",
    ExecutablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99\\app\\ChatGPT.exe",
    AppId: "OpenAI.Codex_2p2nqsd0c76g0!App",
  };
  let powershellCalls = 0;
  assert.doesNotThrow(() =>
    launchWindowsCodex(
      { executablePath: official.ExecutablePath, appId: official.AppId },
      {
        spawnImpl: () => {
          powershellCalls += 1;
          return powershellCalls === 1
            ? { status: 0, stdout: JSON.stringify(official) }
            : { status: 0, stdout: "" };
        },
        queryProcesses: () => [{ name: "chatgpt.exe", pid: 456, executablePath: "" }],
      },
    ),
  );
  assert.equal(powershellCalls, 2, "the Store activation fallback should not run");
});

test("the Store activation fallback keeps elseif and else attached to the conditional", () => {
  const official = {
    PackageFamilyName: "OpenAI.Codex_2p2nqsd0c76g0",
    InstallLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99",
    ExecutablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99\\app\\ChatGPT.exe",
    AppId: "OpenAI.Codex_2p2nqsd0c76g0!App",
  };
  const commands = [];
  launchWindowsCodex(
    { executablePath: official.ExecutablePath, appId: official.AppId },
    {
      spawnImpl: (_file, args) => {
        commands.push(args.at(-1));
        if (commands.length === 1) return { status: 0, stdout: JSON.stringify(official) };
        return { status: commands.length === 2 ? 1 : 0, stdout: "" };
      },
      queryProcesses: () => undefined,
    },
  );
  const fallback = commands.at(-1);
  assert.match(fallback, /\} elseif \(\$env:CODEX_ROUTER_CODEX_EXE\)/);
  assert.match(fallback, /\} else \{ exit 1 \}/);
  assert.doesNotMatch(fallback, /\}; (?:elseif|else)/);
});

test("an elevated ChatGPT process can switch after the Store package is verified", async () => {
  const elevatedHost = { name: "chatgpt.exe", pid: 456, parentPid: 1, executablePath: "" };
  const bundledCli = { name: "codex.exe", pid: 457, parentPid: 456, executablePath: "" };
  let processes = [elevatedHost, bundledCli];
  const events = [];
  const result = await withRestartedCodexDesktop(async () => {
    events.push("operation");
    return "done";
  }, {
    platform: "win32",
    queryProcesses: () => processes,
    discoverLaunch: () => ({
      executablePath: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_99\\app\\ChatGPT.exe",
      appId: "OpenAI.Codex_2p2nqsd0c76g0!App",
    }),
    stopImpl: () => {
      events.push("stop");
      processes = [];
    },
    startImpl: () => events.push("start"),
  });
  assert.equal(result, "done");
  assert.deepEqual(events, ["stop", "operation", "start"]);
});

test("a hidden ChatGPT process remains fail-closed when the Store package cannot be verified", async () => {
  let operated = false;
  await assert.rejects(
    withRestartedCodexDesktop(async () => {
      operated = true;
    }, {
      platform: "win32",
      queryProcesses: () => [{ name: "chatgpt.exe", pid: 456, executablePath: "" }],
      discoverLaunch: () => ({ executablePath: "", appId: "" }),
    }),
    /installed Codex desktop app could not be found/i,
  );
  assert.equal(operated, false);
});

test("a hidden elevated ChatGPT process skips PID killing and uses the verified-package stop", () => {
  const commands = [];
  stopWindowsProcessTree([{ name: "chatgpt.exe", pid: 456, executablePath: "" }], {
    spawnImpl: (command, args) => {
      commands.push([command, args]);
      return { status: 0, stdout: "" };
    },
  });
  assert.deepEqual(commands.map(([command]) => command), ["powershell.exe"]);
  assert.match(commands[0][1].at(-1), /Start-Process/);
});

test("the elevated stop re-enumerates the official package after UAC", () => {
  let elevatedScript = "";
  let processChecks = 0;
  stopWindowsProcessTree([host], {
    spawnImpl: (command, _args, options) => {
      if (command === "powershell.exe") {
        elevatedScript = Buffer.from(
          options.env.CODEX_ROUTER_ELEVATED_STOP_SCRIPT,
          "base64",
        ).toString("utf16le");
      }
      return { status: 1, stdout: "" };
    },
    queryProcesses: () => {
      processChecks += 1;
      return processChecks === 1 ? [host] : [];
    },
  });
  assert.match(elevatedScript, /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(elevatedScript, /Get-CimInstance Win32_Process/);
  assert.match(elevatedScript, /OpenAI\.Codex_2p2nqsd0c76g0/);
  assert.equal(elevatedScript.includes(String(host.pid)), false);
});
