const required = ['SENTRY_DSN', 'SENTRY_PUBLIC_DSN']
const optional = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']

let missing = 0

for (const name of required) {
  if (process.env[name]) {
    console.log(`PASS ${name}: present`)
  } else {
    missing += 1
    console.log(`WARN ${name}: missing`)
  }
}

for (const name of optional) {
  console.log(`${process.env[name] ? 'PASS' : 'INFO'} ${name}: ${process.env[name] ? 'present' : 'not set'}`)
}

console.log(`Checked ${required.length + optional.length} Sentry env var names without printing values.`)
process.exitCode = missing > 0 ? 1 : 0
