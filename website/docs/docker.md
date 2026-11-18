---
title: 'Without Node: the Docker image'
---

# Without Node: the Docker image

You don't need Node or npm to build a site on Inlay: the Docker image runs every `inlaycms` command for you. This page is for anyone who'd rather install Docker than Node, on their own computer or in CI.

The Inlay image holds the whole CLI as well as the host, so a computer with Docker needs no Node or npm. It's published on GitHub's container registry as `ghcr.io/donstephan/inlaycms`. Install the `inlaycms` script it carries:

```sh
docker run --rm ghcr.io/donstephan/inlaycms cat /opt/inlaycms/wrapper/inlaycms > ~/.local/bin/inlaycms
chmod +x ~/.local/bin/inlaycms
```

Then use `inlaycms` in a site's folder as anywhere else in these docs: `inlaycms dev`, `inlaycms check`, `inlaycms pack`, `inlaycms push`. A site needs no `node_modules`: its `inlaycms` imports load the image's copy, and `inlaycms pack` type-checks with the image's TypeScript when the site has a `tsconfig.json`. A site that uses npm packages installs them as usual, with npm or through the image (`docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:$PWD" -w "$PWD" -e HOME=/tmp ghcr.io/donstephan/inlaycms npm install <package>`).

The script runs the image on the current folder, mounted at the same path, so paths mean the same inside and out; files outside the folder aren't visible to the command. What it writes belongs to you. `dev` and `serve` publish their port on this computer only (`127.0.0.1`). Without `INLAY_DATA_DIR`, `dev` and the database commands keep their data in the site folder, as without Docker; with it, that folder is mounted too. Its settings:

- `INLAY_IMAGE`: the image to run (default `ghcr.io/donstephan/inlaycms`, the newest release you have pulled), such as a version (`ghcr.io/donstephan/inlaycms:0.2.0`) or an image built from [Inlay's repository](https://github.com/donstephan/inlaycms) with `pnpm run image` (`inlaycms`).
- `INLAY_DOCKER_ARGS`: more `docker run` options, split on spaces. Pass a secret the site declares with `-e CAPTCHA_SECRET`, and reach a server on this computer for `inlaycms push http://localhost:3000` with `--network host`.
- Every other `INLAY_` variable is passed to the command.

`docker pull ghcr.io/donstephan/inlaycms` updates the image to the newest release. The image's default command is `inlaycms serve`, with its data in a volume at `/data` (see [Running a host](/docs/guides/releases#running-a-host)).

## Types in your editor

Without `node_modules`, an editor on your computer can't find Inlay's types. Open the site in a dev container on the image instead (VS Code's Dev Containers, or any editor that reads `.devcontainer/devcontainer.json`): the editor runs inside the image, where `inlaycms` resolves from any folder.

```json
{
  "name": "Inlay site",
  "image": "ghcr.io/donstephan/inlaycms",
  "containerEnv": { "INLAY_DATA_DIR": "" },
  "forwardPorts": [3000]
}
```

In its terminal, run `inlaycms dev` and the other commands directly, without the script. Or install `inlaycms` with npm only for the types and keep using the image to run it.
