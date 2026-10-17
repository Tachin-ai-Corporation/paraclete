# install/lib/names.sh: the name of everything install.sh creates and uninstall.sh removes. Kept in one
# place so the two scripts can never disagree about what belongs to paraclete. Defines names and
# functions only. Sourced by install/install.sh and install/uninstall.sh; install/lib/dashboard.mjs
# (and through it dev/deploy.mjs) reads its NAME=value lines, so keep each a plain assignment.

# Service accounts (build plan section 3, "Identities"). config/instance.mjs derives the agent's own
# identity from the first name, and the control service trusts commands signed by the second;
# tests/config/instance.test.mjs checks the names agree.
AGENT_ACCOUNT_ID=paraclete-agent
DASHBOARD_ACCOUNT_ID=paraclete-dashboard
DWD_ACCOUNT_ID=paraclete-dwd

# The agent's VM, the network tag its firewall rule targets, and that rule. IAP's TCP forwarding
# reaches VMs from this range only, so SSH through IAP is the one way in.
VM_NAME=paraclete
NETWORK_TAG=paraclete
FIREWALL_RULE=paraclete-allow-iap-ssh
IAP_SOURCE_RANGE=35.235.240.0/20
FIREWALL_RULE_PRIORITY=1000
# Everything else inbound is denied for the VM's tag. A default network carries its own allow rules
# (SSH and RDP from anywhere, ICMP) at priority 65534; this deny outranks them, and the IAP allow above
# outranks it.
DENY_RULE=paraclete-deny-ingress
DENY_RULE_PRIORITY=65000

# The network install.sh creates when the project has no `default` network. Networks carry no labels,
# so the description marks it as the installer's: uninstall.sh removes it only when it matches.
NETWORK_NAME=paraclete
NETWORK_DESCRIPTION='Created by the paraclete installer'

# The dashboard's Cloud Run service and the Artifact Registry repository its image lives in.
SERVICE_NAME=paraclete
IMAGE_REPOSITORY=paraclete

FIRESTORE_DATABASE='(default)'

# account_email <account id> <project>: a service account's email address.
account_email() {
  printf '%s@%s.iam.gserviceaccount.com\n' "$1" "$2"
}

# bucket_name <project>: the instance's bucket.
bucket_name() {
  printf '%s-paraclete\n' "$1"
}
