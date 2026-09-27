# ADR 0001: One monorepo

**Status:** accepted · 26 Sep 2026

**Context.** Two people, 16 days, a program whose interface changes daily, and judges who review one repository.

**Decision.** A single public monorepo: Cargo workspace for the program, pnpm workspace for TypeScript. The IDL is the contract between them.

**Consequences.** Program, SDK, services and app change in one PR; CI covers everything. After an audit, the program may move to its own repo to be frozen.
