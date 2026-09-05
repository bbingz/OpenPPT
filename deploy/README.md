# Private-network Docker deployment

Build and run on the remote Docker host; never run Docker on the development Mac.
The CLI remains loopback-only. The container uses an explicit `publicOrigin` and
requires exact Host/Origin matches for the configured browser endpoint, including
SSE. This is a single-user trusted-network service, without application login.
Bind only to the host's private/Tailscale IP; do not publish it to the internet.

After all PR checks pass for the exact commit, copy that Git archive to a fresh
release directory on macmini-m1. Use a stable Compose project name (`openppt`) so
the `openppt_projects` volume survives releases. The image includes LibreOffice,
Poppler and CJK fonts; user projects remain outside the image.

```sh
export OPENPPT_REVISION=<full-verified-commit>
export OPENPPT_BIND_IP=<host-tailscale-ip>
export OPENPPT_PUBLIC_ORIGIN=http://macmini-m1:7357
docker compose -p openppt -f deploy/compose.yaml config --quiet
docker compose -p openppt -f deploy/compose.yaml build --pull
docker compose -p openppt -f deploy/compose.yaml up -d --wait --wait-timeout 120
```

The browser must use the configured hostname and port. A request addressed by a
different alias/IP is rejected. No reverse proxy, authentication bypass or
wildcard Origin is configured. For HTTPS, terminate TLS at an independently
configured trusted proxy and use its exact HTTPS origin.

Before replacing an existing deployment, record its image ID, revision, release
directory and environment file; back up its project volume while writes are
paused. Keep the previous image and release. Roll back by restoring that release's
environment and running `up -d --no-build --wait` against its compose file. For a
first deployment, rollback is `stop`; retain the project volume. Never use `down -v`.

Verify container health, the actual browser workbench, create/save/PATCH/SSE,
PPTX download and PDF export before claiming deployment success. The image revision
label must equal the CI-verified commit; health/version alone does not prove it.
