# install/lib/json.sh: reads values out of the repo's JSON files (config/contracts.json, a role's
# role.json) with node, so the scripts never keep a second copy of a value. Defines functions only.
# Sourced by install/install.sh and install/uninstall.sh.

# json_get <file> <key.path>: prints the value at key.path. A string, number or boolean prints as is;
# an array prints one element per line (an empty array prints nothing). Fails, naming the file and the
# key, when the key is missing.
json_get() {
  node -e '
const fs = require("node:fs");
const [file, path] = process.argv.slice(1);
let value = JSON.parse(fs.readFileSync(file, "utf8"));
for (const key of path.split(".")) {
  if (value === null || typeof value !== "object" || !(key in value)) {
    console.error(`${file} has no ${path}`);
    process.exit(1);
  }
  value = value[key];
}
for (const item of Array.isArray(value) ? value : [value]) {
  process.stdout.write(`${typeof item === "object" ? JSON.stringify(item) : item}\n`);
}
' "$1" "$2"
}

# contract <key.path>: a value from config/contracts.json. REPO_ROOT is the repo the script runs from.
contract() {
  json_get "$REPO_ROOT/config/contracts.json" "$1"
}
