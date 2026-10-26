# install/lib/indexes.sh: the Firestore indexes and TTL policies in install/firestore.indexes.json,
# and which of them a project already has. An index is identified by its signature (collection group,
# query scope, and its fields in order with their directions), so an index created by hand or by an
# earlier install counts as present. Defines functions only. Sourced by install/install.sh and
# install/uninstall.sh.

# The one program behind these functions (install/lib/indexes.mjs), which the lab provisioner imports too,
# so the signature is computed one way everywhere.
INDEXES_MJS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/indexes.mjs"

# index_plan <indexes file>: the composite indexes the file lists (indexes.mjs plan).
index_plan() {
  node "$INDEXES_MJS" plan "$1"
}

# ttl_plan <indexes file>: the TTL policies the file lists, as <collection group> TAB <field>.
ttl_plan() {
  node "$INDEXES_MJS" ttls "$1"
}

# index_ids: <signature> TAB <index id> for each index in a composite-index listing read from stdin.
index_ids() {
  node "$INDEXES_MJS" ids
}

# existing_indexes <project>: <signature> TAB <index id> for each composite index the project's
# database has. Empty when the database or the API isn't there yet.
existing_indexes() {
  local listing
  listing="$(gcloud firestore indexes composite list --database="$FIRESTORE_DATABASE" --project="$1" --format=json 2>/dev/null)" || return 0
  index_ids <<<"$listing"
}

# index_id <existing indexes> <signature>: the id of the existing index with that signature, or nothing.
index_id() {
  awk -F'\t' -v signature="$2" '$1 == signature { print $2; exit }' <<<"$1"
}

# existing_ttls <project>: <field resource name> TAB <state> for each TTL field the database has.
existing_ttls() {
  gcloud firestore fields ttls list --database="$FIRESTORE_DATABASE" --project="$1" \
    --format='value(name,ttlConfig.state)' 2>/dev/null || true
}

# ttl_state <existing ttls> <collection group> <field>: the TTL state of one field, or nothing.
ttl_state() {
  awk -F'\t' -v suffix="/collectionGroups/$2/fields/$3" \
    'length($1) >= length(suffix) && substr($1, length($1) - length(suffix) + 1) == suffix { print $2; exit }' <<<"$1"
}
