import {
  SourceControlProviderKind,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import { parseSmithLogins } from "./smithAuthStatus.ts";

const processOutput = TestSourceControlHost.processOutput;

const smithStatus = [
  "code.test (default)",
  "  ✓ Logged in to code.test as maria (/home/maria/.config/smith/hosts.zon)",
  "  - Login: browser; the access token renews itself",
  "  - Git operations protocol: ssh",
  "  - SSH host: ssh.code.test",
  "  - Token: eyJh************",
  "work.test:3000",
  "  ✓ Logged in to work.test:3000 as bot (/home/maria/.config/smith/hosts.zon)",
  "  - Active account: no",
  "  - Git operations protocol: https",
  "  - Token: abcd************",
  "  X the token for maria on work.test:3000 is invalid or expired",
  "  - Active account: yes",
  "  - Git operations protocol: https",
  "  - Token: efgh************",
  "scoped.test",
  "  ✓ Logged in to scoped.test (/home/maria/.config/smith/hosts.zon); the token cannot read the user",
  "  - Git operations protocol: ssh",
  "  - Token: ijkl************",
  "",
].join("\n");

const context = (remoteUrl: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("forgejo"),
    name: "Forgejo",
    baseUrl: "https://code.test",
  },
  remoteName: "origin",
  remoteUrl,
});

const missing = (input: SourceControlHost.SourceControlProcessInput) =>
  Effect.fail(
    new VcsProcessSpawnError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      cause: new Error(`${input.command} not found`),
    }),
  );

// A host where fj is not installed, so its keys file does not exist.
const smithHost = (
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  requests: string[] = [],
) =>
  Layer.mergeAll(
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        requests.push(request.url);
        assert.strictEqual(request.headers.authorization, "token smith-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("[]", {
              headers: { link: '<https://code.test/api/v1/next?page=2>; rel="next"' },
            }),
          ),
        );
      }),
    ),
    TestSourceControlHost.layer({ process: { run } }),
  );

const signedIn = (commands: string[]) => (input: SourceControlHost.SourceControlProcessInput) => {
  commands.push(`${input.command} ${input.args.join(" ")}`);
  if (input.command !== "smith") return missing(input);
  if (input.args[1] === "status") return Effect.succeed(processOutput(smithStatus));
  if (input.args[0] === "api") return Effect.succeed(processOutput('{"login":"maria"}'));
  return Effect.succeed(processOutput("smith-token\n"));
};

const failure = <A>(exit: Exit.Exit<A, ForgejoCli.ForgejoCliError>) => {
  assert.isTrue(Exit.isFailure(exit));
  return Option.getOrThrow(
    Exit.findErrorOption(exit as Exit.Exit<never, ForgejoCli.ForgejoCliError>),
  );
};

it("reads each host's active account from smith auth status", () => {
  assert.deepStrictEqual(parseSmithLogins(smithStatus), [
    {
      name: "code.test",
      url: "https://code.test",
      ssh_host: "ssh.code.test",
      valid: "true",
      user: "maria",
      default: "true",
    },
    {
      name: "work.test:3000",
      url: "https://work.test:3000",
      valid: "false",
      user: "",
      default: "false",
    },
    { name: "scoped.test", url: "https://scoped.test", valid: "true", user: "", default: "false" },
  ]);
  assert.deepStrictEqual(
    parseSmithLogins(
      "\u001b[1mcode.test\u001b[0m (default)\n  ✓ Logged in to code.test as maria (hosts.zon)\n",
    ).map((login) => [login.name, login.default, login.user]),
    [["code.test", "true", "maria"]],
  );
});

it.effect(
  "calls the Forgejo API with smith's token and asks smith again only after 30 seconds",
  () => {
    const commands: string[] = [];
    const requests: string[] = [];
    return Effect.gen(function* () {
      const cli = yield* ForgejoCli.make;
      const list = (remoteUrl: string) =>
        cli.api({
          cwd: "/repo",
          repository: "maria/project",
          context: context(remoteUrl),
          path: "repos/maria/project/pulls?state=open",
        });
      const results = yield* Effect.all(
        [
          list("git@ssh.code.test:maria/project.git"),
          list("https://code.test/maria/project.git"),
          list("git@ssh.code.test:maria/project.git"),
        ],
        { concurrency: "unbounded" },
      );
      for (const result of results) {
        assert.strictEqual(result.stdout, "[]");
        assert.match(result.stderr, /^link: <.*page=2>; rel="next"$/m);
      }
      assert.deepStrictEqual(
        yield* cli.resolveRepository({
          cwd: "/repo",
          repository: "project",
          context: context("git@ssh.code.test:maria/project.git"),
        }),
        {
          command: "smith",
          login: "code.test",
          repository: "maria/project",
          baseUrl: "https://code.test",
        },
      );
      assert.deepStrictEqual(
        requests,
        Array(3).fill("https://code.test/api/v1/repos/maria/project/pulls?state=open"),
      );
      const firstRound = [
        "smith auth status",
        "smith api --hostname code.test user",
        "smith auth token --hostname code.test",
      ];
      assert.deepStrictEqual(commands, firstRound);
      yield* TestClock.adjust("31 seconds");
      yield* list("https://code.test/maria/project.git");
      assert.deepStrictEqual(commands, [...firstRound, ...firstRound]);
    }).pipe(Effect.provide(smithHost(signedIn(commands), requests)));
  },
);

it.effect.each([
  [
    "rejected",
    4,
    "smith: HTTP 401\n",
    "authentication",
    "Authenticate this server with `smith auth login --hostname code.test`.",
  ],
  ["unreachable", 1, "smith: HTTP 502\n", undefined, "smith could not reach code.test (HTTP 502)."],
] as const)(
  "stays on smith when it reports the login %s",
  ([, exitCode, stderr, reason, detail]) => {
    const commands: string[] = [];
    return Effect.gen(function* () {
      const cli = yield* ForgejoCli.make;
      const error = failure(
        yield* Effect.exit(
          cli.api({
            cwd: "/repo",
            repository: "maria/project",
            context: context("https://code.test/maria/project.git"),
            path: "user",
          }),
        ),
      );
      assert.deepStrictEqual(
        [error.command, error.reason, error.detail],
        ["smith", reason, detail],
      );
      assert.isFalse(commands.some((command) => command.startsWith("tea ")));
      assert.notInclude(commands, "smith auth token --hostname code.test");
    }).pipe(
      Effect.provide(
        smithHost((input) => {
          commands.push(`${input.command} ${input.args.join(" ")}`);
          return Effect.succeed(
            input.args[1] === "status"
              ? processOutput(smithStatus)
              : processOutput("", { stderr, exitCode: ChildProcessSpawner.ExitCode(exitCode) }),
          );
        }),
      ),
    );
  },
);

it.effect("uses a smith token that cannot read the user, and rejects an empty one", () =>
  Effect.gen(function* () {
    for (const [token, works] of [
      ["smith-token\n", true],
      ["\n", false],
    ] as const) {
      const exit = yield* Effect.exit(
        ForgejoCli.make.pipe(
          Effect.flatMap((cli) =>
            cli.api({
              cwd: "/repo",
              repository: "maria/project",
              context: context("https://code.test/maria/project.git"),
              path: "repos/maria/project",
            }),
          ),
          Effect.provide(
            smithHost((input) =>
              Effect.succeed(
                input.args[1] === "status"
                  ? processOutput(smithStatus)
                  : input.args[0] === "api"
                    ? processOutput("{}", {
                        stderr: "smith: HTTP 403\n",
                        exitCode: ChildProcessSpawner.ExitCode(1),
                      })
                    : processOutput(token),
              ),
            ),
          ),
        ),
      );
      if (works) assert.isTrue(Exit.isSuccess(exit));
      else assert.strictEqual(failure(exit).reason, "authentication");
    }
  }),
);

it.effect("reports a smith status that fails for a reason other than a missing CLI", () =>
  Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const error = failure(
      yield* Effect.exit(
        cli.listLogins!({
          cwd: "/repo",
          command: "smith",
          remoteUrl: "https://code.test/maria/project.git",
        }),
      ),
    );
    assert.strictEqual(error.command, "smith");
    assert.notStrictEqual(error.reason, "missing-cli");
  }).pipe(
    Effect.provide(
      smithHost((input) =>
        Effect.fail(
          new VcsProcessTimeoutError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            timeoutMs: 30_000,
          }),
        ),
      ),
    ),
  ),
);

it.effect.each([
  ["fj and tea are missing", "signed-in", false, "smith", "authenticated"],
  ["smith is signed out and tea is installed", "signed-out", true, "tea", "authenticated"],
  ["fj, smith and tea are all missing", "missing", false, "tea", "unknown"],
] as const)("discovers Forgejo when %s", ([, smith, tea, executable, auth]) =>
  Effect.gen(function* () {
    const spec = yield* ForgejoSourceControlProvider.makeDiscovery;
    if (spec.type !== "managed-cli") return yield* Effect.die("managed discovery expected");
    const result = yield* spec.probe("/repo");
    assert.deepStrictEqual([result.executable, result.auth.status], [executable, auth]);
    if (smith === "signed-in") {
      assert.deepStrictEqual(result.auth.account, Option.some("maria"));
      assert.deepStrictEqual(result.auth.host, Option.some("code.test"));
      const refined = yield* spec.refineUnknownRemote({
        cwd: "/repo",
        context: context("git@ssh.code.test:maria/project.git"),
      });
      assert.strictEqual(refined?.baseUrl, "https://code.test");
    }
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ForgejoCli.layer,
        smithHost((input) => {
          if (input.command === "git")
            return Effect.succeed(processOutput("git@ssh.code.test:maria/project.git\n"));
          if (input.command === "smith" && smith !== "missing")
            return Effect.succeed(
              input.args[0] === "--version"
                ? processOutput("smith 0.7.0")
                : smith === "signed-in"
                  ? processOutput(smithStatus)
                  : processOutput("", { exitCode: ChildProcessSpawner.ExitCode(1) }),
            );
          if (input.command === "tea" && tea)
            return Effect.succeed(
              input.args[0] === "--version"
                ? processOutput("tea version 0.16.0")
                : processOutput(
                    '[{"name":"work","url":"https://code.test","user":"maria","default":"true","valid":"true"}]',
                  ),
            );
          return missing(input);
        }),
      ),
    ),
  ),
);
