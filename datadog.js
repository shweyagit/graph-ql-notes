/**
 * Datadog APM initialisation — must be imported before any other module.
 *
 * Usage (package.json scripts):
 *   node --import ./datadog.js server.js
 *
 * What this enables automatically (via dd-trace):
 *   • HTTP request traces + durations
 *   • GraphQL operation traces (query / mutation / subscription)
 *   • Runtime metrics (CPU, heap, event-loop lag)
 *   • Log correlation (trace-id injected into console output)
 *
 * Custom metrics exported from here:
 *   • graphql.errors   — incremented per GraphQL error, tagged by operation
 *   • graphql.requests — incremented per GraphQL request, tagged by operation type
 */

import tracer from 'dd-trace'

tracer.init({
  service:        process.env.DD_SERVICE || 'gql-notes',
  env:            process.env.DD_ENV     || 'development',
  hostname:       'localhost',
  port:           8126,
  logInjection:   true,
  runtimeMetrics: true,
})

export default tracer

/**
 * graphql-yoga plugin — tracks GraphQL-level errors and request counts.
 *
 * Attach in createYoga({ plugins: [datadogPlugin()] })
 */
export function datadogPlugin() {
  return {
    onExecute({ args }) {
      const operationName = args.operationName || 'anonymous'

      // Determine operation type (query / mutation / subscription)
      const opType = args.document?.definitions?.[0]?.operation ?? 'unknown'

      tracer.dogstatsd.increment('graphql.requests', 1, [
        `operation:${operationName}`,
        `type:${opType}`,
        `service:gql-notes`,
        `env:${process.env.DD_ENV || 'development'}`,
      ])

      return {
        onExecuteDone({ result }) {
          const errors = Array.isArray(result)
            ? result.flatMap(r => r.errors ?? [])
            : result.errors ?? []

          if (errors.length > 0) {
            // Mark the active APM span as an error so it shows in Datadog APM error counts
            const span = tracer.scope().active()
            if (span) {
              span.setTag('error', true)
              span.setTag('error.type', 'GraphQLError')
              span.setTag('error.message', errors[0].message)
              span.setTag('graphql.operation', operationName)
            }

            errors.forEach(err => {
              tracer.dogstatsd.increment('graphql.errors', 1, [
                `operation:${operationName}`,
                `type:${opType}`,
                `error:${err.message.slice(0, 80)}`,
                `service:gql-notes`,
                `env:${process.env.DD_ENV || 'development'}`,
              ])
            })
          }
        },
      }
    },
  }
}
