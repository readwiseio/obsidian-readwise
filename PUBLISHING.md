# Publishing a New Version

Use this when shipping a new Readwise Official Obsidian plugin version.

Publishing has two separate steps:

1. Merge a version-bump PR.
2. Tag and publish the GitHub release.

## 1. Create the Version-Bump PR

Start from `master` and choose the new version:

```sh
VERSION=3.0.4
git switch master
git pull --ff-only
git switch -c "release/$VERSION"
```

Update the version in all required places:

```sh
npm version "$VERSION" --no-git-tag-version
```

Then manually update:

- `manifest.json`: set `version` to `$VERSION`
- `versions.json`: add `$VERSION` with the supported Obsidian app version

If the minimum Obsidian version did not change, copy the previous `versions.json` value.

Run checks:

```sh
npm run ci
```

Open a PR containing only the version-bump files:

- `package.json`
- `package-lock.json`
- `manifest.json`
- `versions.json`

Merge that PR before publishing.

## 2. Tag the Merged Version

After the version-bump PR is merged:

```sh
git switch master
git pull --ff-only
git tag "$VERSION"
git push origin "$VERSION"
```

Pushing the tag starts the `Release Obsidian plugin` GitHub Action.

## 3. Publish the Release

The release workflow creates a draft GitHub release. Obsidian cannot install from a draft release.

After the action succeeds, publish the release:

```sh
gh release edit "$VERSION" \
  --repo readwiseio/obsidian-readwise \
  --draft=false \
  --latest
```

You can also publish it from the GitHub release page.

## 4. Verify

Make sure the assets Obsidian installs are public:

```sh
for asset in manifest.json main.js styles.css; do
  curl -L -f -o /dev/null \
    "https://github.com/readwiseio/obsidian-readwise/releases/download/$VERSION/$asset"
done

gh release list --repo readwiseio/obsidian-readwise --limit 3
```

The new release should show as `Latest`, not `Draft`.

## If Obsidian Install Fails

If Obsidian shows `Failed to install plugin` and the console has a 404, check:

- the release is published, not draft
- the tag matches `manifest.json` `version`
- the release has `main.js`, `manifest.json`, and `styles.css`

Useful command:

```sh
gh release view "$VERSION" \
  --repo readwiseio/obsidian-readwise \
  --json tagName,isDraft,publishedAt,assets \
  --jq '.'
```
