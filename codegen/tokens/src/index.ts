// Public entry point for @figma-normalizator/codegen-tokens.
//
// This package is being built out in stages (see the migration plan) on top
// of schema/tokens/v1 Token IR: input validation (envelope/policy/unresolved
// handling), the codegen model (classification, mode expansion, dependency
// graph), and the Kotlin emitter. Nothing is exported yet — this file exists
// so the package's build/typecheck scripts have something to run against
// while the rest of the package is scaffolded in.
export {};
