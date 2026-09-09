import assert from "node:assert/strict";
import test from "node:test";

import { chatGptAccountTrayTemplate } from "../apps/control-center/electron/tray-account-menu.mjs";

test("the account tray orders profiles, marks the active one, and dispatches switches", () => {
  const switched = [];
  const menu = chatGptAccountTrayTemplate({
    accounts: {
      second: { id: "second", label: "Work", priority: 20, state: "active", subscription: { usable: true } },
      first: { id: "first", label: "Personal", priority: 80, state: "active", subscription: { usable: true } },
    },
    profile: { active: "first", pending: false },
  }, { onSwitch: (id) => switched.push(id) });

  assert.equal(menu.label, "OpenAI account");
  assert.deepEqual(menu.submenu.slice(0, 2).map((item) => item.label), ["Personal", "Work"]);
  assert.equal(menu.submenu[0].checked, true);
  assert.equal(menu.submenu[1].checked, false);
  menu.submenu[1].click();
  assert.deepEqual(switched, ["second"]);
});

test("the account tray uses the same email-first account name as the Control Center", () => {
  const menu = chatGptAccountTrayTemplate({
    accounts: {
      saved: {
        id: "saved",
        label: "ChatGPT account 1",
        state: "active",
        subscription: { email: "personal@example.com", usable: true },
      },
    },
    profile: { active: "saved", pending: false },
  });

  assert.equal(menu.submenu[0].label, "personal@example.com");
});

test("the account tray renders empty, pending, and busy states without unsafe actions", () => {
  const empty = chatGptAccountTrayTemplate({ accounts: {}, profile: {} });
  assert.deepEqual(empty.submenu[0], { label: "No saved accounts", enabled: false });

  const pending = chatGptAccountTrayTemplate({
    accounts: {
      next: { id: "next", priority: 1, state: "active", subscription: { usable: true } },
    },
    profile: { active: "old", desired: "next", pending: true },
  }, { busy: true });
  assert.equal(pending.submenu[0].checked, true);
  assert.equal(pending.submenu[0].enabled, false);
  assert.equal(pending.submenu.at(-1).label, "Switching account...");
});
