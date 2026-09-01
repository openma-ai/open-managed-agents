# Managed Agents Port boundaries

The application core owns both sides of every use case boundary:

- inbound Ports describe commands, queries, views, and explicit expected outcomes;
- outbound Ports describe semantic capabilities required from persistence and runtime adapters.

The dependency direction is always outer to inner:

```text
HTTP / SDK adapter -> inbound application Port -> application service
                                             -> outbound persistence/runtime Port <- concrete adapter
```

## Hard rules

1. Application source never imports the HTTP adapter package, Anthropic SDK,
   Hono, Zod, an ORM, a SQL schema, or a concrete runtime driver.
2. Port properties use application-native camelCase. Wire names and storage
   column names terminate in their adapters.
3. Expected absence, invalid input, and optimistic concurrency conflicts are
   discriminated results. They do not cross a Port as exceptions or ambiguous
   `null` values.
4. Port methods take named semantic input objects. Positional identifier and
   version arguments are forbidden because they are easy to transpose.
5. Domain models are defined once and shared by the two Port sides; inbound
   views and persistence records may not silently drift into separate shapes.
6. Atomicity belongs to the outbound capability. For agent replacement the
   caller supplies `expectedVersion` and `next`; persistence reads and stores
   the previous snapshot inside the same atomic write. A caller-provided prior
   snapshot is not trusted.
7. Concrete adapters live outside this package. The SQL adapter depends on the
   persistence Port and the runtime-neutral `SqlClient`, not Drizzle, D1,
   better-sqlite3, postgres.js, or an HTTP package.
8. All public inbound resource Ports live under `src/ports`. HTTP packages may
   re-export them for compatibility but may not own or redeclare them.
9. Authentication context and request-scoped Port resolution are composition
   concerns. Application Ports receive a semantic `workspaceId` through their
   service dependencies and never receive Hono context, headers, or request
   objects.
10. Capability segregation applies at the adapter boundary: CRUD, event
    streaming, resources, and threads use separate Ports even when their HTTP
    routes share a URL prefix.
11. Runtime coordination is expressed as domain-shaped command Ports. Session
    start receives the persisted Session and validated Environment snapshots
    plus initial events. Stop, event dispatch, thread lifecycle, and live
    subscription inputs also carry the already-validated Session/Thread
    snapshots they require. Event dispatch additionally carries the complete
    Environment snapshot from a tenant-scoped execution-context Source Port,
    including archived Environments still referenced by existing Sessions.
    Adapters may not recover context by reaching into legacy tables, concrete
    repositories, or request objects.
12. Lifecycle, event dispatch, thread lifecycle, history persistence, and live
    streams are distinct capabilities. A concrete runtime adapter may implement
    several of them, but the application services depend only on the capability
    they invoke.
13. Runtime output re-enters through the internal
    `SessionRuntimeProjectionApplicationPort`; a runtime adapter may not write
    session or event persistence directly. Projecting runtime history and the
    derived Session state is one optimistic, atomic persistence capability.
14. Runtime projection event inserts are revision-guarded and idempotent by
    semantic event ID. A failed Session CAS may not leave an event row behind.
15. Source Ports return the complete application-owned snapshot needed by the
    use case. Boolean existence probes are forbidden: they discard validated
    context and force downstream adapters to perform a second, hidden lookup.
16. Application-native domain types remain strongly typed and camelCase until
    the final transport boundary. Runtime drivers may not weaken a Port payload
    to `object`, a serialized document, or a bag of identifiers.
17. Runtime history is loaded through a request-scoped application Port backed
    by a tenant-scoped Source Port. It returns complete application-native
    initial and persisted event snapshots; only the final runtime adapter may
    encode them into a harness- or provider-specific representation.
18. Accepting an event batch that changes Session aggregate state is one
    revision-guarded persistence capability. The event rows and next Session
    snapshot commit atomically; runtime dispatch begins only from the committed
    result and never from caller-assumed state.
19. The HTTP adapter may bundle related routes, but the bundle accepts only
    application-owned inbound Port sources. It cannot import a concrete service,
    persistence/runtime adapter, legacy router, registry, or store to complete a
    missing capability.
20. Command input types and persisted snapshots are different contracts. Input
    types may express official optionality (`null`, omitted defaults, `self`, or
    latest-version selectors); an application service must resolve them before a
    domain snapshot reaches persistence or a runtime Port. Resolved snapshots may
    not contain input-only sentinels.
21. Adapter codecs are explicit and one-way. HTTP codecs translate official wire
    DTOs at the inbound/outbound HTTP edge; legacy runtime codecs translate only
    after the application Port. A generic key-case transform, structural cast, or
    shared `object` payload is not a substitute for either codec.
22. Current and historical lookups remain separate Source Port capabilities. A
    use case that resolves a pinned version checks the current record for an exact
    version match before consulting history; adapters may not reinterpret
    `findVersion` as an implicit current-or-history lookup.

Glob-based boundary tests enforce these rules for every inbound Port and every
outbound persistence, source, resource resolver, runtime command, and stream
Port. The HTTP
adapter has a separate architecture test requiring all resource routes to
resolve their inbound Port from the current request context.
