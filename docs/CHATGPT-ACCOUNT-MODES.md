# ChatGPT native account switching

Codex Router keeps each ChatGPT login in its own isolated profile. The feature is deliberately switch-only: selecting an account changes the native ChatGPT login. It does not run automatic quota or round-robin routing.

## Select an account

Choose a saved account from the account list in Control Center. The selected login remains saved under its own account profile. By default, if ChatGPT is open, the change is queued and applied after ChatGPT closes; the previous login is never deleted or overwritten as another account.

The optional **Automatically restart ChatGPT when switching accounts** setting closes a running, verified desktop app, applies the login, and reopens the app. A closed app stays closed. Windows resolves the current Microsoft Store package at switch time so app updates do not invalidate its launch path. Linux automatic restart is available only for the verified system installation at `/usr/lib/chatgpt/ChatGPT`; a running unverified package is refused before the login changes.

## Account data and catalog

Each account keeps its own native model catalog and routed model overlay. Switching restores that account's catalog, so models unavailable to one ChatGPT plan are not shown as available under another plan. External provider credentials and subagent routes are preserved.

## Usage

Control Center reads usage from up to eight saved, usable accounts' isolated `CODEX_HOME` directories, prioritizing the selected account. It shows the weekly window when OpenAI reports one, otherwise the monthly window. Returning to another account reloads that account's quota and reset time.

## Token refresh

Authenticated account profiles are checked for near-expiry access tokens. When a token is close to expiry, Codex Router runs the official Codex login-status refresh against that account's isolated `CODEX_HOME`, with a retry interval and no credential output. Refreshing one account does not replace another account's profile.

## Safety

An automatic switch waits for the ChatGPT process tree to close and refuses to change credentials while an independent Codex CLI process is running. It fails closed when process or executable verification is unavailable, and attempts to reopen a previously running app even if the protected profile operation fails. Profile copies reject symlinks, bind a saved account to the verified ChatGPT identity, use atomic private-file replacement, and restore the previous profile and catalog if a refresh fails. Concurrent switches are serialized.
