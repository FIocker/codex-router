function accountLabel(account) {
  return account?.subscription?.email
    || account?.label
    || account?.identity?.email
    || "ChatGPT account";
}

function orderedAccounts(snapshot) {
  return Object.values(snapshot?.accounts || {}).sort((left, right) => (
    Number(right?.priority || 0) - Number(left?.priority || 0)
    || String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""))
    || accountLabel(left).localeCompare(accountLabel(right))
  ));
}

export function chatGptAccountTrayTemplate(snapshot, {
  busy = false,
  onManage = () => {},
  onRefresh = () => {},
  onSwitch = () => {},
} = {}) {
  const accounts = orderedAccounts(snapshot);
  const active = snapshot?.profile?.active;
  const desired = snapshot?.profile?.desired;
  const selected = snapshot?.profile?.pending ? desired : active;
  const accountItems = accounts.length
    ? accounts.map((account) => ({
        label: accountLabel(account),
        type: "radio",
        checked: account.id === selected,
        enabled: !busy && account.state === "active" && account.paused !== true
          && account.subscription?.usable === true,
        click: () => onSwitch(account.id),
      }))
    : [{ label: snapshot ? "No saved accounts" : "Loading accounts...", enabled: false }];

  return {
    label: "OpenAI account",
    submenu: [
      ...accountItems,
      { type: "separator" },
      { label: "Manage accounts...", enabled: !busy, click: onManage },
      { label: busy ? "Switching account..." : "Refresh account status", enabled: !busy, click: onRefresh },
    ],
  };
}
