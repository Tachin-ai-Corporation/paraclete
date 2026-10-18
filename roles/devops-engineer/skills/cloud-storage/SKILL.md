# Skill: Cloud Storage

## When to use

When the work reads or writes Cloud Storage: what a bucket holds, copying files to or from it, keeping
a directory and a prefix in sync, and object metadata. Use `gcloud storage`; `gsutil` is installed too
and does the same with older syntax, so use it only to follow instructions written for it. There are no
commands of its own.

To fetch one object into a mission, or hand a file back to a person, use the files skill instead
(`file-get gs://...`, `file-share`): this skill is for buckets as infrastructure.

## What your account can do

Read and write objects in any bucket of the project, and see buckets and their settings. It cannot
create or delete a bucket, change a bucket's settings (location, lifecycle, CORS, versioning,
public access prevention) or anyone's access to it. When the work needs that, ask a person for exactly
that change, with the command. A bucket in another project needs a grant there.

The instance's own bucket, `<project>-paraclete`, holds its files and its git artifact store. Read it
freely; write to it only through your own commands (`file-share`, `work-sync`) and the staging prefix
the container-images skill uses.

## Read

| What | Command |
|---|---|
| Buckets | `gcloud storage buckets list --project=<project> --format='value(name)'` |
| A bucket's settings | `gcloud storage buckets describe gs://<bucket>` |
| Objects under a prefix | `gcloud storage ls gs://<bucket>/<prefix>/` (`-l` adds size and time, `-r` recurses) |
| One object's metadata | `gcloud storage objects describe gs://<bucket>/<object>` |
| Total size | `gcloud storage du --summarize --readable-sizes gs://<bucket>/<prefix>/` |
| Every object under a prefix | `gcloud storage ls 'gs://<bucket>/<prefix>/**'`; pipe it to `wc -l` to count them |
| An object's contents | `gcloud storage cat gs://<bucket>/<object>`; pipe a large one to `head -c 20000` |

## Write

| What | Command |
|---|---|
| Upload a file | `gcloud storage cp <file> gs://<bucket>/<path>` |
| Download one | `gcloud storage cp gs://<bucket>/<path> <file>` |
| Never overwrite | add `--no-clobber` |
| Mirror a directory | `gcloud storage rsync <dir> gs://<bucket>/<prefix> --recursive` |
| Set caching or type | `gcloud storage objects update gs://<bucket>/<object> --cache-control='public, max-age=3600'` (also `--content-type`) |
| Delete objects | `gcloud storage rm gs://<bucket>/<object>`; a prefix needs `--recursive` |

## Procedures

### Publish a directory to a prefix

1. List what is there now: `gcloud storage ls -r gs://<bucket>/<prefix>/ | head -50`, and count it.
2. Rehearse: `gcloud storage rsync <dir> gs://<bucket>/<prefix> --recursive --dry-run` prints every
   copy, and every deletion if you add `--delete-unmatched-destination-objects`.
3. Read the rehearsal. Deleting objects that are not in your directory is a step for an approval gate,
   with the list of what goes; without that flag nothing is deleted.
4. Run the same command without `--dry-run`.
5. Verify: list the prefix again and compare the count and a few sizes with the directory.

### Find what fills a bucket

1. `gcloud storage du --summarize --readable-sizes gs://<bucket>/` for the total.
2. `gcloud storage du --summarize --readable-sizes 'gs://<bucket>/*'` for each top-level prefix, then
   the same one level deeper into the largest.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `403` / `does not have storage.objects.*` | The bucket is in another project, or the grant is missing | Report the bucket and the permission named |
| `does not have storage.buckets.create` or `.update` | Bucket creation and settings are a person's | Ask for exactly that change |
| `404` | Wrong bucket or object name | List again; names are case-sensitive |
| A sync wants to delete far more than expected | Source and destination were swapped, or the prefix is wrong | Stop. Fix the command and rehearse again |

## Safety

- Rehearse every `rsync` with `--dry-run`, and never add `--delete-unmatched-destination-objects`
  without an approval of the list it deletes.
- List before you delete, and delete exactly the objects listed.
- Never make an object public with an ACL: buckets here use uniform access, and public access is a
  bucket-level decision a person makes.
