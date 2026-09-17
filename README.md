# Local GPO Compliance Tester

A Windows desktop app that lets you **preview, test, apply, and revert** what a
compliance baseline would do to your machine's **Local Group Policy** — before
it surprises you in production.

Pick a standard (**NIST 800‑171 / 800‑53**, **CMMC L2**, **HIPAA**, or **SOC 2**),
scan the running services and processes to predict *what would break*, compare
every current policy value against what the standard wants, apply the ones you
choose (which writes the policy and runs `gpupdate /force`), and roll any change
back — all changes, a single batch, or one setting at a time.

> ⚠️ **This tool modifies Local Group Policy and security policy on the machine it
> runs on.** Use it on systems you are authorized to change. Always test on a
> non‑production machine first. See [Safety & scope](#safety--scope).

---

## Features

- **Compliance standard picker** — NIST, CMMC L2, HIPAA, SOC 2, each with a
  curated set of policy settings and target values.
- **Scan for Potential Issues** — enumerates running Windows services and
  processes and cross‑references them against the settings that would change, so
  you get a ranked (High / Medium / Low) list of what is *likely to break* and
  why. For example, enforcing password expiry is flagged **High** when SQL
  Server / IIS / a backup service is running under a dedicated account.
- **Side‑by‑side comparison** — every setting's **current** value next to what
  the selected baseline **would set it to**, with the potential impact inline.
- **Selective apply** — tick the settings you want, click **Apply**; the app
  writes them (via `secedit` for security policy and the registry for
  administrative‑template settings) and runs `gpupdate /force`.
- **Revert in batches** — every apply is recorded. The **Revert Changes** dialog
  lets you undo **everything**, a **whole batch**, **selected items**, or a
  **single setting**, then re‑runs `gpupdate /force`.
- **Check for updates** — pulls the latest published GitHub Release and installs
  it in place (via `electron-updater`).
- **Simulation mode** — on non‑Windows machines (or with `GPO_SIMULATE=1`) the
  entire flow runs against a mock policy store so you can explore the UI safely.

---

## How it works

| Setting family | Mechanism |
| --- | --- |
| Password & account‑lockout policy, audit policy | Read via `secedit /export`, written via `secedit /configure` |
| Security options & administrative templates (UAC, SMBv1, RDP NLA, firewall, AutoPlay, PowerShell logging, LM auth level, …) | Read via `reg query`, written via `reg add` / `reg delete` under the policy/system hives |
| Applying changes | `gpupdate /force` after each apply or revert |
| Scanning | `Get-CimInstance Win32_Service` (running services) and `tasklist` (processes) |

The catalog of settings lives in [`src/data/catalog.json`](src/data/catalog.json)
and each standard's target values live in
[`src/data/baselines/`](src/data/baselines). Both are validated by
`npm run lint:json`.

Before every apply, the app captures the **current** raw value of each setting it
is about to change and stores it in a batch record (in the app's user‑data
folder). Revert simply re‑applies those captured values (deleting a registry
value again if it did not exist before).

---

## Install

Download the latest **`Local GPO Compliance Tester-Setup-x.y.z.exe`** from the
[Releases page](https://github.com/trendlinepros-afk/Local-GPO-testing/releases)
and run it. The installer requests Administrator rights because writing Local
Group Policy requires elevation.

Once installed, use **Check for updates** in the app to stay current.

---

## Run from source (development)

```bash
git clone https://github.com/trendlinepros-afk/Local-GPO-testing.git
cd Local-GPO-testing
npm install

# Run against the real Local Group Policy (Windows, run an elevated terminal):
npm start

# Run anywhere in safe simulation mode (mock policy, no system changes):
npm run dev
```

Handy scripts:

| Script | What it does |
| --- | --- |
| `npm start` | Launch the app |
| `npm run dev` | Launch in forced simulation mode (`GPO_SIMULATE=1`) |
| `npm run lint:json` | Validate the setting catalog and baselines |
| `npm run dist` | Build the installer locally without publishing |
| `npm run release` | Build **and** publish a GitHub Release (CI uses this) |

## Build an installer

```bash
npm run dist      # output in dist/
```

`electron-builder` produces an NSIS installer for Windows x64. The app icon is
generated from [`build/icon.png`](build/icon.png)
(`node scripts/generate-icon.js` regenerates it).

---

## Updates & releases

The **Check for updates** button uses
[`electron-updater`](https://www.electron.build/auto-update), which reads the
newest **published GitHub Release** (the installer plus the generated
`latest.yml`).

**To ship an update:**

1. Bump `version` in `package.json`.
2. Merge to **`main`**.
3. The [Build & Release workflow](.github/workflows/release.yml) runs on
   `windows-latest`, builds the installer, and publishes a GitHub Release tagged
   `v<version>`.
4. Installed apps see it on the next **Check for updates**.

> Because releases are published from **`main`**, changes must land on `main` for
> the update mechanism to serve them — exactly as intended.

---

## The compliance baselines

These baselines encode **commonly audited** values for each framework. They are a
practical starting point, **not** legal or certification advice — always
reconcile against your own assessor's requirements.

- **NIST SP 800‑171 / 800‑53 (Moderate)** — protecting Controlled Unclassified
  Information (CUI).
- **CMMC 2.0 Level 2** — mirrors the 110 practices of NIST SP 800‑171.
- **HIPAA Security Rule** — technical/administrative safeguards for ePHI
  (risk‑based, so values reflect common auditor expectations).
- **SOC 2 (Trust Services Criteria)** — widely accepted control implementations
  for the Security criteria.

---

## Safety & scope

- **Authorized use only.** This app changes Local Group Policy and security
  policy on the machine it runs on. Only run it where you are permitted to make
  those changes.
- **Test first.** Try changes on a non‑production machine or VM. Some settings
  (SMBv1, LM auth level, UAC) can require a **reboot** and can affect legacy
  device connectivity.
- **Revert is your friend.** Every apply is recorded so you can undo it, but a
  revert is only as good as the value captured at apply time. Keep your own
  backups / restore points for anything critical.
- **Local policy only.** This tool edits *local* GPO. On a domain‑joined
  machine, domain GPOs can override local settings at the next policy refresh.

---

## Project layout

```
src/
  main/            Electron main process
    gpo/           read / apply / revert engine, catalog + baseline logic
    util/          command runner
    updater.js     electron-updater wiring + dev fallback
    preload.js     safe IPC bridge (contextIsolation)
    main.js        window + IPC handlers
  renderer/        UI (index.html, styles.css, app.js)
  data/
    catalog.json   every setting: how to read/write it + impact rules
    baselines/     target values per standard
scripts/           data validator + icon generator
.github/workflows/ CI (validate) + Release (build & publish)
```

## License

[MIT](LICENSE)
