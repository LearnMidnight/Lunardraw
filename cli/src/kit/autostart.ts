/**
 * Keep the agent running in the background (`lunardraw-agent serve`), from
 * when its owner signs in to the computer: for AIs on the web or a phone
 * (they reach it through the relay), and so every AI app on the computer
 * shares one agent whose wallet is already open (host.ts).
 *
 *   Windows  a small script in the Startup folder that starts it hidden
 *   macOS    a LaunchAgent (~/Library/LaunchAgents/io.lunardraw.agent.plist)
 *   Linux    a systemd user service (lunardraw-agent.service), or an autostart entry
 *
 * Each says what it is inside, and removing it (`lunardraw-agent remote off
 * --stop-at-login`) stops that.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Launch = { command: string; args: string[]; env?: Record<string, string> };

const LABEL = 'io.lunardraw.agent';

/** Where the start-at-sign-in entry lives here. */
export const autostartFile = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  platform === 'win32'
    ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Lunardraw agent.vbs')
    : platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
      : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd', 'user', 'lunardraw-agent.service');

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The entry's text, for each system. */
export const autostartText = (launch: Launch, log: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') {
    // VBScript doubles quotes inside a string; Run(…, 0) starts it with no window
    const q = (s: string) => `""${s.replace(/"/g, '""""')}""`;
    const line = [launch.command, ...launch.args].map(q).join(' ');
    const env = Object.entries(launch.env ?? {}).map(([k, v]) => `sh.Environment("PROCESS")("${k}") = "${v.replace(/"/g, '""')}"`);
    return [
      "' Starts the Lunardraw agent (lunardraw-agent serve) in the background when you sign in,",
      "' so your AI can play Starfall. Delete this file, or run: lunardraw-agent remote off --stop-at-login",
      'Set sh = CreateObject("WScript.Shell")',
      ...env,
      `sh.Run "${line}", 0, False`,
      '',
    ].join('\r\n');
  }
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Lunardraw agent (lunardraw-agent serve), so your AI can play Starfall. Remove: lunardraw-agent remote off --stop-at-login -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[launch.command, ...launch.args].map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
${launch.env ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(launch.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}\n  </dict>\n` : ''}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  }
  const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);
  return `# The Lunardraw agent (lunardraw-agent serve), so your AI can play Starfall.
# Remove: lunardraw-agent remote off --stop-at-login
[Unit]
Description=Lunardraw agent

[Service]
ExecStart=${[launch.command, ...launch.args].map(sq).join(' ')}
${Object.entries(launch.env ?? {}).map(([k, v]) => `Environment=${sq(`${k}=${v}`)}\n`).join('')}Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
};

const quiet = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30_000 });

/** Start the agent when the owner signs in (and, where the system does it, now). Returns what was set up. */
export const startAtLogin = (launch: Launch, log: string): { file: string; startsNow: boolean } => {
  const file = autostartFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, autostartText(launch, log));
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    quiet('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    return { file, startsNow: quiet('launchctl', ['bootstrap', `gui/${uid}`, file]).status === 0 };
  }
  if (process.platform === 'linux') {
    const ok = quiet('systemctl', ['--user', 'daemon-reload']).status === 0 && quiet('systemctl', ['--user', 'enable', '--now', 'lunardraw-agent.service']).status === 0;
    if (!ok) {
      // no systemd for this user: a desktop autostart entry instead
      rmSync(file, { force: true });
      const desktop = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'lunardraw-agent.desktop');
      mkdirSync(dirname(desktop), { recursive: true });
      writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=Lunardraw agent\nComment=lunardraw-agent serve, so your AI can play Starfall\nExec=${[launch.command, ...launch.args].map((a) => `"${a}"`).join(' ')}\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`);
      return { file: desktop, startsNow: false };
    }
    return { file, startsNow: true };
  }
  return { file, startsNow: false };
};

/** Stop starting the agent at sign-in (and stop the one the system started). */
export const stopAtLogin = (): string | undefined => {
  const file = autostartFile();
  if (process.platform === 'darwin') quiet('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
  if (process.platform === 'linux') quiet('systemctl', ['--user', 'disable', '--now', 'lunardraw-agent.service']);
  const desktop = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'lunardraw-agent.desktop');
  for (const f of [file, desktop]) {
    if (existsSync(f)) {
      rmSync(f);
      return f;
    }
  }
  return undefined;
};

export const startsAtLogin = (): boolean =>
  existsSync(autostartFile()) || existsSync(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'lunardraw-agent.desktop'));

/** Start the agent in the background now, writing to its log. */
export const startInBackground = (launch: Launch, log: string): void => {
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, 'a');
  const child = spawn(launch.command, launch.args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...(launch.env ?? {}) },
  });
  child.unref();
};
