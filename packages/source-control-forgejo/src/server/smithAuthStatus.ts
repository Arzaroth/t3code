// `smith auth status` prints each host unindented, followed by its accounts' indented lines.
export function parseSmithLogins(raw: string) {
  const hosts: Array<{
    readonly name: string;
    readonly isDefault: boolean;
    readonly accounts: Array<{ user: string; valid: boolean; active: boolean; sshHost?: string }>;
  }> = [];
  for (const line of raw.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const host = /^(\S+)( \(default\))?$/.exec(line);
    if (host?.[1]) {
      hosts.push({ name: host[1], isDefault: !!host[2], accounts: [] });
      continue;
    }
    const accounts = hosts.at(-1)?.accounts;
    if (!accounts) continue;
    const status = /^\s+([✓X]) (?:Logged in to \S+(?: as (\S+))?)?/.exec(line);
    if (status) {
      accounts.push({ user: status[2] ?? "", valid: status[1] === "✓", active: true });
      continue;
    }
    const account = accounts.at(-1);
    if (!account) continue;
    if (/^\s+- Active account: no$/.test(line)) account.active = false;
    const sshHost = /^\s+- SSH host: (\S+)$/.exec(line)?.[1];
    if (sshHost) account.sshHost = sshHost;
  }
  return hosts.flatMap(({ name, isDefault, accounts }) => {
    // smith prints no account line for a host it could not reach; keep it so its error surfaces.
    const account = accounts.find((item) => item.active) ??
      accounts[0] ?? { user: "", valid: false, active: true };
    return [
      {
        name,
        url: `https://${name}`,
        ...(account.sshHost ? { ssh_host: account.sshHost } : {}),
        valid: String(account.valid),
        user: account.user,
        default: String(isDefault),
      },
    ];
  });
}
