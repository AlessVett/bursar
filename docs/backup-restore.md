# Backups and restore

Bursar copies its encrypted database every night, keeps the copies on the data volume, and uploads them to an S3-compatible bucket if you configure one. This guide covers what a backup holds, how long copies are kept, how to set up Cloudflare R2, the command-line tools, how to put a restored database in place, and the restore test that proves it all works.

This guide uses placeholders: `<host>` (ssh alias of the Docker host), `<dir>` (deploy directory on the host), `<setId>` (a backup set id such as `20261109T030000Z`).

## 1. What a backup set contains

A backup set is a folder named by its UTC creation time, `YYYYMMDDTHHMMSSZ`, with two files:

- `bursar.db`: a consistent copy of the database, made with SQLite's `VACUUM INTO`. It is still encrypted with the SQLCipher key derived from the master key, so neither the local disk copy nor the bucket ever holds plaintext data. Before upload, Bursar opens the copy with the derived key and runs an integrity check; a copy that fails is not uploaded.
- `manifest.json`: the format version, the set id, the creation time, the number of schema migrations, and the name, size and SHA-256 of every file. It is uploaded last, so a set without a manifest is incomplete and is ignored by `backup list` and `restore`.

The master key is never stored in a backup. You need it to read any set: keep an offline copy of `<dir>/secrets/master_key` (for example in a password manager), and keep it apart from the bucket. A backup without the key cannot be decrypted, and a stolen bucket without the key is ciphertext.

The documents archive arrives with a later milestone; the manifest has room for more files.

## 2. Schedule and retention

- A backup runs once a day at the time set in Settings, Backups (default 03:00 in the server's time zone). You can also run one on demand with "Back up now" in Settings, Backups, or from the command line.
- Every backup is kept on the data volume in `/data/backups`, and also uploaded to the bucket when one is configured. The local copies live on the same disk as the database: they protect against mistakes and corruption, not against losing the disk or the host. Settings, Backups shows a persistent warning while no remote target is configured.
- Retention keeps 7 daily, 4 weekly and 6 monthly sets (the newest set of each of the last 7 days, 4 weeks and 6 months; the newest set is always kept). It is applied to the local folder and to the bucket after every successful backup.
- After two failed backups in a row, Bursar raises a notification linking to Settings, Backups. The same page lists the recent runs.

## 3. Remote target: Cloudflare R2

Cloudflare R2 is the reference target; any S3-compatible service that supports path-style addresses and AWS Signature Version 4 should work the same way, but only R2 is documented here.

1. In the Cloudflare dashboard, open R2 and create a bucket. Keep it private: no public access, no custom domain.
2. Create an R2 API token with the Object Read and Write permission, restricted to that one bucket. Bursar lists, uploads, downloads and deletes objects (retention deletes old sets), so the token must allow all four. The labels in the dashboard may differ from these names.
3. Copy the **Access Key ID**, the **Secret Access Key** (shown once) and the S3 endpoint, which looks like `https://<account-id>.r2.cloudflarestorage.com`.
4. Put the non-secret values in `<dir>/.env`:

        BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
        BACKUP_S3_REGION=auto
        BACKUP_S3_BUCKET=<bucket name>
        BACKUP_S3_PREFIX=bursar
        BACKUP_S3_ACCESS_KEY_ID=<access key id>

5. Write the secret access key into `<dir>/secrets/backup_s3_secret_key` (owner 1000, mode 600) without putting it in a command line or shell history, then check ownership and modes only:

        ssh <host> 'set -C; umask 077; cat > <dir>/secrets/backup_s3_secret_key && chown 1000:1000 <dir>/secrets/backup_s3_secret_key && chmod 600 <dir>/secrets/backup_s3_secret_key'
        ssh <host> 'ls -la <dir>/secrets'

   Paste the key, press Enter, then Ctrl-D. `set -C` makes the command fail instead of replacing an existing file.
6. Deploy. `deploy/remote-update.sh` adds `deploy/compose.backup.yaml` when `backup_s3_secret_key` exists. The endpoint, bucket, access key id and secret key go together: with only some of them the app refuses to start and names the missing variables.

Do not add an R2 lifecycle rule that deletes objects: Bursar prunes by its own retention policy.

Settings, Backups now shows the target as remote. Run a first backup to check it:

    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup run'

Expected: a JSON line with `setId`, `sizeBytes` and `"target":"s3"`.

## 4. Command line

The commands run inside the container, as the app user, with the app's own configuration (master key, bucket settings). On a host:

    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup run'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup list'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup list --remote'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js restore --set <setId> --from s3 --to <target dir>'

- `backup run` makes a backup now and prints `{"setId":…,"sizeBytes":…,"target":…}`.
- `backup list` prints the set ids in the local folder, newest first; `--remote` lists the bucket.
- `restore --set <setId> --to <dir> [--from local|s3] [--force]` writes `<dir>/bursar.db` (mode 600) from the chosen set, after checking the manifest checksums, opening the database with the master key and running an integrity check. It prints `{"restored":"<setId>","tables":{…}}` with the row count of each table. It refuses to overwrite an existing `bursar.db` unless you pass `--force`. Pass `--from` explicitly.
- `banking status [--data-dir <dir>]` prints the connections and accounts with their transaction counts (masked identifiers only). With `--data-dir` it reads the database in that directory.

In development, run the same commands with `pnpm --filter @bursar/server bursar backup run` and so on.

A failed restore exits with status 1 and one of these codes:

- `set_not_found`: the set does not exist or has no manifest.
- `checksum_mismatch`: a file differs from the manifest (corrupted or tampered).
- `wrong_key`: the database cannot be opened with this master key.
- `integrity_failed`: the database opens but fails its integrity check.
- `target_not_empty`: the target already holds a `bursar.db`.

## 5. The restore test

A backup you have never restored is a hope, not a backup. Run this test after the first remote backup, after changing the target, the bucket or the key handling, and from time to time afterwards. It restores into a scratch directory in the container's memory-backed `/tmp` and never touches the live database.

    ssh <host> 'docker exec bursar-app-1 node dist/cli.js backup run'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js restore --set <setId> --from s3 --to /tmp/restore-test'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js banking status --data-dir /tmp/restore-test'
    ssh <host> 'docker exec bursar-app-1 node dist/cli.js banking status'
    ssh <host> 'docker exec bursar-app-1 rm -rf /tmp/restore-test'

It passes when:

- the backup reports `"target":"s3"` and the restore exits with status 0;
- the table counts printed by `restore` are plausible for your data (accounts, transactions);
- `banking status --data-dir /tmp/restore-test` lists the same connections and accounts as the live `banking status`, with the same transaction counts (a sync that ran between the two commands can add a few).

The project's automated tests also run a backup and a restore against temporary folders on every change, including the failure cases above. They prove the code path, not your bucket, your token or your key, which is why the manual test matters.

## 6. Put a restored database in place

Use this to recover from a damaged database or to move to a new host. It replaces the live database with the one from a backup set, so everything written after that backup is lost. The previous files are moved aside, not deleted.

Run the commands in a shell on the host (not through nested `ssh '…'` quoting). `compose` is the same set of files the deploy uses; add `-f` for the overlays whose secret files exist:

    cd <dir>
    compose=(docker compose --env-file <dir>/.env -f <dir>/current/deploy/compose.yaml \
      -f <dir>/current/deploy/compose.banking.yaml -f <dir>/current/deploy/compose.smtp.yaml \
      -f <dir>/current/deploy/compose.backup.yaml)

1. Choose the set: `"${compose[@]}" exec app node dist/cli.js backup list --remote` (or without `--remote`).
2. Stop the app: `"${compose[@]}" stop app`.
3. Restore the set into a new folder on the data volume, next to the live database:

        "${compose[@]}" run --rm --no-deps app node dist/cli.js restore --set <setId> --from s3 --to /data/restore-<setId>

4. Check it: `"${compose[@]}" run --rm --no-deps app node dist/cli.js banking status --data-dir /data/restore-<setId>`.
5. Swap the files. The live database has companion files, `bursar.db-wal` and `bursar.db-shm`; they must move with it, because a leftover `-wal` file would be applied to the wrong database:

        "${compose[@]}" run --rm --no-deps --entrypoint sh app -c '
          set -eu
          cd /data
          stamp="$(date -u +%Y%m%dT%H%M%SZ)"
          mkdir "replaced-$stamp"
          mv bursar.db "replaced-$stamp/"
          for f in bursar.db-wal bursar.db-shm; do [ ! -e "$f" ] || mv "$f" "replaced-$stamp/"; done
          mv "restore-<setId>/bursar.db" bursar.db
          rmdir "restore-<setId>"
          echo "previous database kept in /data/replaced-$stamp"
        '

6. Start the stack and wait until it is healthy: `"${compose[@]}" --profile tunnel up -d --wait --wait-timeout 180`.
7. Check: open the panel and sign in (sessions and the password come back with the database), run `docker exec bursar-app-1 node dist/cli.js banking status`, and read `docker logs --since 5m bursar-app-1` for errors.

After a restore:

- Syncs fetch what is missing since the backup, within what each bank still provides (often about 90 days).
- The restored database contains the backup run that was in progress when the copy was taken, still marked as running. The first start marks it failed with "Interrupted by a restart": this is expected, not a fault. The next scheduled backup (or `backup run`) is the first real one after the restore.
- A bank consent renewed after the backup points the restored database at the old, closed session. That connection shows as expired: renew it from the Accounts page.
- The restored database is the one the master key opens. With a different master key the restore stops with `wrong_key`.
- Keep `/data/replaced-<stamp>` until you are satisfied. When you want it gone, remove it deliberately, for example with a `run --rm --no-deps --entrypoint sh app -c 'rm -r /data/replaced-<stamp>'`.

### On a new host

Prepare the host and the secrets as in `docs/deployment.md`, with the **same** `master_key` file and the `BACKUP_S3_*` values (and the `backup_s3_secret_key` file), deploy once, then follow the steps above from step 1 with `--from s3`.
