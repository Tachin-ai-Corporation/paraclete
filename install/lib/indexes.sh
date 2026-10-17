# install/lib/indexes.sh: the Firestore indexes and TTL policies in install/firestore.indexes.json,
# and which of them a project already has. An index is identified by its signature (collection group,
# query scope, and its fields in order with their directions), so an index created by hand or by an
# earlier install counts as present. Defines functions only. Sourced by install/install.sh and
# install/uninstall.sh.

# The one node program behind these functions, so the signature is computed one way everywhere.
#   plan <file>  one line per composite index in the file:
#                <signature> TAB <collection group> TAB <query scope> TAB <field-path>=<order>[;...]
#   ttls <file>  one line per TTL policy in the file: <collection group> TAB <field>
#   ids          reads `gcloud firestore indexes composite list --format=json` on stdin and prints
#                <signature> TAB <index id> per index
INDEXES_JS='
const fs = require("node:fs");
const [mode, file] = process.argv.slice(1);
const signature = (group, scope, fields) => [
  group,
  String(scope || "COLLECTION").toLowerCase(),
  fields
    .filter((f) => f.fieldPath !== "__name__")
    .map((f) => `${f.fieldPath}:${String(f.order || f.arrayConfig).toLowerCase()}`)
    .join(","),
].join("|");
if (mode === "plan") {
  for (const index of JSON.parse(fs.readFileSync(file, "utf8")).indexes || []) {
    const fields = index.fields.map((f) => `${f.fieldPath}=${String(f.order).toLowerCase()}`).join(";");
    const scope = String(index.queryScope || "COLLECTION").toLowerCase().replace(/_/g, "-");
    console.log([signature(index.collectionGroup, index.queryScope, index.fields), index.collectionGroup, scope, fields].join("\t"));
  }
} else if (mode === "ttls") {
  for (const field of JSON.parse(fs.readFileSync(file, "utf8")).fieldOverrides || []) {
    if (field.ttl === true) console.log(`${field.collectionGroup}\t${field.fieldPath}`);
  }
} else if (mode === "ids") {
  const text = fs.readFileSync(0, "utf8").trim();
  for (const index of text ? JSON.parse(text) : []) {
    const match = /\/collectionGroups\/([^/]+)\/indexes\/([^/]+)$/.exec(index.name || "");
    if (match) console.log(`${signature(match[1], index.queryScope, index.fields || [])}\t${match[2]}`);
  }
} else {
  console.error(`indexes: unknown mode ${mode}`);
  process.exit(2);
}
'

# index_plan <indexes file>: the composite indexes the file lists (see INDEXES_JS, mode plan).
index_plan() {
  node -e "$INDEXES_JS" plan "$1"
}

# ttl_plan <indexes file>: the TTL policies the file lists, as <collection group> TAB <field>.
ttl_plan() {
  node -e "$INDEXES_JS" ttls "$1"
}

# index_ids: <signature> TAB <index id> for each index in a composite-index listing read from stdin.
index_ids() {
  node -e "$INDEXES_JS" ids
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
