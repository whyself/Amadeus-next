export function apply(ctx) {
  const routes = new Map()
  ctx.provide('webServer', {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    registerUpgrade(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ workspaceRoot: process.cwd() }) })
  ctx.provide('workingDirectory', { defaultDirectory: process.cwd(), get: () => process.cwd() })
  ctx.provide('sessions', { get: () => undefined })
}
