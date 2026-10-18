# Skill: Custom Domains

## When to use

When a site already live on Firebase Hosting (`<site>.web.app`) should answer on a real domain, an apex
like `example.com` or a subdomain like `www.example.com`; or when a connected domain stopped working.
Deploying the site itself is the firebase-hosting skill's. There are no commands of its own: you call
Firebase Hosting's REST API with `curl` and `jq`, and check DNS with `dig` and TLS with `openssl`.

## Who does what

1. **You register** the domain with the site. Hosting then says which DNS records it needs: a `TXT`
   record proving the domain is the site's, and `A`, `AAAA` or `CNAME` records sending visitors to it.
2. **A person adds those records** at whatever provider hosts the domain's DNS. You have no access to
   anyone's DNS and never ask for it: you hand over the records, exactly as Hosting gave them.
3. **You check** until Hosting reports the domain active and its certificate issued, then prove it
   answers over HTTPS.

Never write records from memory or an example: Hosting's addresses change, so use what the API returns
now.

## The API

Every call starts with these two lines, in the same command (each command you run starts a fresh
shell, so nothing set in an earlier one is there):

```bash
TOKEN="$(gcloud auth print-access-token)"
BASE="https://firebasehosting.googleapis.com/v1beta1/projects/<project>/sites/<site>/customDomains"
```

Then one of:

```bash
# the site's domains, one per line
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE" \
  | jq -r '.customDomains[]? | [.name, .hostState // "", .ownershipState // "", .cert.state // ""] | @tsv'

# one domain's state
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/<domain>" \
  | jq '{hostState, ownershipState, cert: .cert.state, issues}'

# register a domain
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' \
  "$BASE?customDomainId=<domain>"

# remove a domain (only with an approval that names it)
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/<domain>"

# the DNS records still to change
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/<domain>" | jq -r '
  [(.requiredDnsUpdates.desired // [])[], (.cert.verification.dns.desired // [])[]]
  | map(.records // []) | add // []
  | .[] | select(.requiredAction != null and .requiredAction != "NONE")
  | [.requiredAction, .type, .domainName, .rdata] | @tsv'
```

Registering returns a long-running operation; read the domain itself afterwards. A domain registered
already answers the registration with an error saying it exists: read its state instead.

`ADD` rows are records to create; `REMOVE` rows are records in the way (an old `A` record, another
host's `TXT`).

| Field | Means |
|---|---|
| `ownershipState` | `OWNERSHIP_ACTIVE` once the `TXT` record is seen; `OWNERSHIP_MISSING` before; `OWNERSHIP_MISMATCH` or `_CONFLICT` when another Firebase project's record is on the domain |
| `hostState` | `HOST_ACTIVE` once every address answers from Hosting; `HOST_MISMATCH` or `HOST_CONFLICT` while old records point elsewhere |
| `cert.state` | `CERT_ACTIVE` when HTTPS works; `CERT_PREPARING`, `CERT_VALIDATING`, `CERT_PROPAGATING` on the way |
| `issues` | What Hosting found wrong, in its own words |

## Procedures

### Connect a domain

1. Confirm the project, the site id and the exact domain with the person, and that the site is live on
   its default URL (the firebase-hosting skill's "Verify a URL").
2. Register it (the table above), then read its records to change.
3. Hand the person the records as a plain table (type, name, value, and whether to add or remove), and
   say where they go: the DNS zone of the base domain, at whoever hosts it. For an apex, several `A`
   values form one record set. A `CNAME` must be the only record on its name.
4. Wait while the records spread: DNS takes minutes to hours, and the certificate up to a day. When the
   records were only just added, leave the mission waiting and check again later rather than checking in
   a loop.
5. Check: the domain's state (above), and what the world sees:
   `dig +short TXT <domain>`, `dig +short A <domain>`, `dig +short CNAME <domain>`.
6. When `hostState` is `HOST_ACTIVE`, `ownershipState` `OWNERSHIP_ACTIVE` and `cert.state` `CERT_ACTIVE`,
   prove it: `curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/` answers 2xx with the site's
   page, and the certificate names the domain:
   `echo | openssl s_client -connect <domain>:443 -servername <domain> 2>/dev/null | openssl x509 -noout -subject -issuer -enddate`.
7. Report the domain as live, with that evidence, and have it recorded in the site's project context.

### A connected domain stopped working

Read its state and `issues` first; they usually name the cause (a record removed at the provider, an
expired certificate, another record added on the name). Compare `dig` with the records Hosting wants, and
hand the person the difference.

### Remove a domain

Removing a domain takes the site off it at once: only with an approval that names the domain. Then
tell the person which DNS records can go.

## Error recovery

| Symptom | Likely cause | What to do |
|---|---|---|
| `403 PERMISSION_DENIED` | The site is in another project, or the grant is missing | Check the project and site id; report the permission named |
| `404` on the site | Wrong site id or project | `firebase hosting:sites:list --project <project>` |
| `OWNERSHIP_MISMATCH` | Another Firebase project's `TXT` record is on the domain | The person removes that record (the `REMOVE` rows) |
| `HOST_CONFLICT` | Old `A` or `AAAA` records still point elsewhere | The person removes them; only Hosting's addresses stay |
| Active, but no certificate after a day | A `CAA` record that excludes Google's authority, or records still in the way | Read `issues` and the `cert` block; hand the person the fix |

## Safety

- You never change DNS, and never ask for DNS credentials.
- The token comes from the machine for each call; never print or save it.
