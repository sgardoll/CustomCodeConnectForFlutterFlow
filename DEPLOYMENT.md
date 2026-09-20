# Deployment

## Deployment targets

There are four surfaces. Two are automated, one goes out over the BuildShip
MCP, and one can only be changed by hand. A change is not deployed until every
surface it touches has been updated — pushing the web app does not deploy a
BuildShip prompt, and vice versa.

| Target | Updated by | Automated |
| --- | --- | --- |
| Web app (`dist/`) | `python3 scripts/deploy_ftp.py` | yes |
| FlutterFlow custom-class runner (`cloud-run/ffai-runner`) | `./scripts/deploy_cloud_run_ffai.sh` | yes |
| BuildShip workflow `service-runpipeline-THIN` | BuildShip MCP, against the workflow graph in the BuildShip repo | via MCP |
| BuildShip step system prompts (`ARCHITECT_SYSTEM`, `GENERATOR_SYSTEM`, `REVIEW_SYSTEM`) | **pasted into the BuildShip editor by hand** | **no** |

The last row is the one that gets missed. See "BuildShip workflow and step
prompts" below.

## Web FTP target

- Host: `ftp.connectio.com.au`
- Port: `21`
- Username: `opencode_upload@connectio.com.au`
- Password: stored in macOS Keychain as generic password service `dreamflowCommandForFlutterFlow.ftp`.

Retrieve password for agent-driven deployment:

```bash
security find-generic-password -s dreamflowCommandForFlutterFlow.ftp -a opencode_upload@connectio.com.au -w
```

Build and upload `dist/`:

```bash
npm run build
python3 scripts/deploy_ftp.py
```

`scripts/deploy_ftp.py` mirrors `dist/` onto the FTP account root: it uploads
every local file, then prunes any remote file that no longer exists locally,
scoped to the directories `dist/` itself manages (the root, `api/`,
`assets/`). This exists because Vite content-hashes built assets
(`index-<hash>.js`), so a stale bundle from the previous build would otherwise
sit on the server forever. It never lists or deletes a remote directory that
has no local counterpart. Use `--dry-run` to preview without changing the
server.

Because pruning deletes remote files, `npm run build` is not optional. The
script refuses to run when `dist/index.html` names a file that was never built:
uploading it would replace the live page with one whose bundle 404s *and* prune
the bundle currently serving the site, so the site would stay down until
someone rebuilt. `dist/index.html` is tracked while `dist/assets/` is
gitignored, so a fresh clone is already in that state until it builds. This
check is not skippable with `--allow-dirty` — that flag covers a `dist/` git
cannot reproduce, not one that is internally broken. `npm run test:deploy-guard`
exercises it.

## FlutterFlow custom-class deploys

FlutterFlow's VS Code extension supports editing existing standalone Custom Code
Files through `syncCustomCodeChanges` (`CodeType.CODE_FILE`, wire type `"C"`).
That endpoint looks up an existing `FFCustomCodeFile` by filename and does not
create a missing entity.

For a new `CustomClass`, the web app calls the Cloud Run AI-DSL runner to
upsert the complete class source with `addCustomClass` or `updateCustomClass`.
That class file is then excluded from the extension-style sync; the remaining
bundle files and dependency changes still use `syncCustomCodeChanges`. Existing
code files that appear in project exports use the normal sync path directly.

FlutterFlow stores a Code File's identifier with its extension
(`groq_model_registry.dart`) and builds `lib/custom_code/<identifier>` from it
verbatim, but `addCustomClass` names the file `snake_case(ClassName)` with no
extension. A class pushed that way emits a file no `import` can resolve, so
every custom widget or action importing it fails to compile. The generated DSL
therefore appends `.dart` after each upsert, leaving a name that already ends
in `.dart` untouched so a re-deploy is a no-op and an editor rename survives.

Before writing anything to the project the runner compiles the generated
classes in a throwaway Flutter package built from the project's own dependency
versions and refuses the deploy (HTTP 422) if the analyzer reports an error.
The FlutterFlow DSL only checks that code is formattable, which accepts a call
to a named argument the package never declared. This needs the Flutter SDK in
the image, so the runner takes longer to build and to cold-start, and the
deploy script raises Cloud Run's request timeout to 900s.

A class that imports FlutterFlow scaffolding (`/backend/schema/structs/index.dart`)
is compiled too: the deploy gathers the transitive closure of each class's
project-relative imports from the export and ships it alongside, bounded by
file and byte caps. The class is written to `lib/custom_code/<stem>.dart` -
where FlutterFlow files it, so a relative import resolves from the right
directory - and the project's generated Dart under `lib/`, which is what the
leading slash resolves against. Analysis is scoped to the deployed class files
with `--no-fatal-warnings`, so an error inside the project's own scaffolding,
or a warning-only class, cannot refuse code that compiles.

The manifest is sent as package names and version constraints, never as
pubspec.yaml text, and the runner builds the document itself - it runs
`pub get` against it on a publicly reachable route, so a caller must not be
able to name a git or path source. `dependency_overrides` are carried over,
because a scratch package resolving different versions than the project would
approve code the project rejects.

A client still sending the older `pubspec` format is recognized, never
executed, and its deploy proceeds with the check reported as unavailable.

**Nothing unverified is deployed.** The web app refuses the deploy on any class
it cannot compile, naming each one and why, before the runner is called.

The runner streams its progress. When the request body sets `"stream": true`
the response is NDJSON — one `{"event":"phase"|"log"|"result"}` object per
line — so the deploy overlay can report the step the runner is really on and
show why a deploy failed part way through. Without that flag the runner
answers with the single JSON body it always did, so an older client keeps
working; likewise a browser talking to a runner deployed before streaming
falls back to an estimated timeline. Redeploy the runner to get live phases.

The production runner defaults to:

```text
https://ccc-ffai-runner-y5cyj3473a-uw.a.run.app/deployCustomClasses
```

Override it at build time with `VITE_FLUTTERFLOW_CLASS_PROVISION_ENDPOINT`.
`VITE_FLUTTERFLOW_DSL_DEPLOY_ENDPOINT` remains accepted for compatibility.
Deploy the runner with:

```bash
PROJECT_ID=low-code-connect REGION=us-west1 ./scripts/deploy_cloud_run_ffai.sh
```

## BuildShip workflow and step prompts

The generation pipeline (Architect → Generator → Review) runs on BuildShip, and
it is a second deployment target with two separately-updated parts.

**Endpoint:** `https://4tgke4.buildship.run/service/runpipeline-image`

**The workflow** `service-runpipeline-THIN` is the graph — nodes, triggers,
input/output schema. It is version-controlled in the BuildShip repo at
`workflows/service-runpipeline-THIN` (a sibling checkout, not this repository)
and pushed with the BuildShip MCP. `npm run verify:buildship-mcp` checks that
the MCP server exposes the tools that does need.

**The step prompts are not part of that push.** Each step's system prompt is a
node *input* on the workflow, and updating the workflow does not update it.
They must be pasted into the BuildShip editor by hand, and that paste **is** the
deploy:

| Step (editor label) | Node name | Node key | Local working copy |
| --- | --- | --- | --- |
| Architect | `ARCHITECT_SYSTEM` | `a4bb0c85-effe-4339-b732-c270e129db59` | `BUILDSHIP_ARCHITECT_SYSTEM_PROMPT_UPDATED.txt` |
| Generator | `GENERATOR_SYSTEM` | `54b162ac-fa03-4614-96f0-5b831162182c` | `BUILDSHIP_GENERATOR_SYSTEM_PROMPT_UPDATED.txt` |
| Review | `REVIEW_SYSTEM` | `d32928b7-5ec4-46f6-9eff-25ea281e4ed2` | `BUILDSHIP_REVIEW_SYSTEM_PROMPT_UPDATED.txt` |

### Where the prompts live, and why not here

**The prompts' source of truth is the private BuildShip workflow, not this
repository** - this repository is public and the prompts are product logic.
`service-runpipeline-THIN` holds all three as node inputs. The `.txt` files
listed above are local working copies only: they are not the deployed value,
they can lag it, and all three are gitignored on purpose (see the note in
`.gitignore`). Keeping them out of version control
here is the intended arrangement, not something to correct.

The BuildShip editor is authoritative for prompt content. The prompt text also
appears in the workflow's `schema.json` under `nodeValues`, but the editor owns
that field and rewrites it on save, so editing it in this repository's sibling
checkout is not a dependable way to deploy a prompt.

To read what the workflow currently records, use the BuildShip MCP
(`get_workflow`, folder `service-runpipeline-THIN`) rather than a local copy.

**Why it matters.** Code-level validation of generated artifacts lives in the
`REVIEW_SYSTEM` prompt, not in `app.js` — widget parameters, return types, file
names, forbidden patterns and imports are all enforced there. So a prompt
change is a deploy in everything but name: until it is pasted into BuildShip,
the client and the pipeline disagree about what is acceptable, and nothing in
this repository will signal that.

## pubspec.yaml dependency sync

Deploys never synthesize a pubspec.yaml. FlutterFlow treats the pushed
`serialized_yaml` as the project's complete dependency set, so the app exports
the project (`exportCode`), reads the real `pubspec.yaml` out of the archive,
adds only the packages the generated code needs, and pushes the merged file
back. If the export cannot be read the deploy fails rather than risk replacing
the project's dependencies.
