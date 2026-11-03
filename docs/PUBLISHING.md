# Publishing the agent kit to npm

`@lunardraw/agent` (the `lunardraw-agent` command and MCP server, source in `cli/src/kit/`) is published from GitHub Actions ([publish-agent.yml](../.github/workflows/publish-agent.yml)), never from a laptop. The workflow:

1. Compiles Starfall with its keys and builds.
2. Runs the command-line tests.
3. Checks the verifier keys against the live Preprod deployment.
4. Packs the kit with `scripts/pack-agent.mjs` (its own pinned and patched dependencies, no proving keys).
5. Installs the package globally on a machine with no C compiler, the way a player would, and runs it (`scripts/smoke-agent.sh`).
6. Publishes **with npm provenance**: the version on npmjs.com shows the commit and the workflow run that built it.

The other workspaces (`@lunardraw/cli`, `keeper`, `contract`) are not published: they travel inside the kit's package.

## How npm trusts the workflow

**Trusted publishing, stage only**, no token, the same as Nightcast's packages.

On npmjs.com, the package's **Settings → Trusted publisher** is set to:

- **Publisher:** GitHub Actions
- **Organisation:** `LearnMidnight`
- **Repository:** `Lunardraw`
- **Workflow:** `publish-agent.yml`
- *Allow npm publish* and *Allow npm dist-tag* **off**

So the workflow can only **stage** a version. The version goes live when an owner approves it with 2FA. **Publishing access** is "Require two-factor authentication and disallow bypass 2fa tokens".

### The first release

The first release (0.1.0) can't use trusted publishing, because the package must exist first. Do it once with a token:

1. **Create the token.** On npmjs.com, go to **Access Tokens → Generate New Token → Granular**:
   - **Packages and scopes:** read and write, limited to the `@lunardraw` scope (the organisation);
   - **Expiry:** 1 day.
2. **Store it in GitHub.** Lunardraw → Settings → Secrets and variables → Actions → New repository secret, named `NPM_TOKEN`.
3. **Dry run.** Actions → Publish the agent kit to npm → Run workflow (branch `main`), with **Dry run** and **First release** both ticked. Read the log.
4. **Publish.** Run it again with **Dry run** unticked and **First release** ticked.
5. **Switch to trusted publishing.** Set the package's trusted publisher (above) and publishing access, then **delete the `NPM_TOKEN` secret and the token**.

## Each later release

1. Raise `version` in `cli/package.json` in a pull request, and merge it.
2. Run the workflow with **Dry run** ticked, and read the log: the size, the verifier keys, "will publish x.y.z".
3. Run it again with **Dry run** unticked and **First release** unticked. This stages the version.
4. Approve it with 2FA: npmjs.com → your avatar → **Staged Packages** (or `npm stage approve <id>`).
5. Check it: run `npm view @lunardraw/agent`, and look at the provenance badge on the package page.

A version can only be withdrawn within 72 hours (`npm unpublish @lunardraw/agent@x.y.z`), and a version number can never be reused. Use `npm deprecate` with a message for anything later.
