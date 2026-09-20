# Deployment

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
versions, and refuses the deploy (HTTP 422) if `flutter analyze` reports an
error. The FlutterFlow DSL only checks that code is formattable, which accepts
a call to a named argument the package never declared. This needs the Flutter
SDK in the image, so the runner takes longer to build and to cold-start, and
the deploy script raises Cloud Run's request timeout to 900s. A class that
imports FlutterFlow scaffolding (`/backend/schema/structs/index.dart`) cannot
be compiled before the app exists; it still deploys and is reported in
`verificationSkipped`, which the web app shows as "Not verified before
deploying".

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

## pubspec.yaml dependency sync

Deploys never synthesize a pubspec.yaml. FlutterFlow treats the pushed
`serialized_yaml` as the project's complete dependency set, so the app exports
the project (`exportCode`), reads the real `pubspec.yaml` out of the archive,
adds only the packages the generated code needs, and pushes the merged file
back. If the export cannot be read the deploy fails rather than risk replacing
the project's dependencies.
