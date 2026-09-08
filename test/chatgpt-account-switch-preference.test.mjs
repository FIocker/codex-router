import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readChatGPTAccountSwitchPreference,
  setChatGPTAccountSwitchAutoRestart,
} from "../src/chatgpt-account-switch-preference.mjs";

test("ChatGPT account auto-restart defaults off and persists explicit choices", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-switch-preference-"));
  const filePath = path.join(root, "private", "preference.json");
  try {
    assert.deepEqual(readChatGPTAccountSwitchPreference(filePath), {
      version: 1,
      autoRestart: false,
      state: "default",
    });
    assert.equal(setChatGPTAccountSwitchAutoRestart(true, filePath).autoRestart, true);
    assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), {
      version: 1,
      autoRestart: true,
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(filePath).mode & 0o077, 0);
    }
    assert.equal(setChatGPTAccountSwitchAutoRestart(false, filePath).autoRestart, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid preference state fails closed and can be repaired explicitly", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chatgpt-switch-preference-invalid-"));
  const filePath = path.join(root, "preference.json");
  try {
    writeFileSync(filePath, "{not-json", "utf8");
    assert.deepEqual(readChatGPTAccountSwitchPreference(filePath), {
      version: 1,
      autoRestart: false,
      state: "unavailable",
    });
    assert.equal(setChatGPTAccountSwitchAutoRestart(true, filePath).state, "configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
