# Document access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native, self-review).

**Goal:** Enforce the table in `docs/superpowers/specs/2026-11-27-document-access-design.md`.
**Architecture:** `documents/document-access.ts` holds the one rule (`canRead(user, doc)`); `DocumentsService.readable(user, id)` and `assertAttachable(user, ids)` use it. Internal `get`/`read` stay unchecked for server code with its own guard.

## Review Focus
Relabelling a file to widen access; attaching someone else's file to your own record; a branch role in another branch; screens that open guides or evidence.

## Tasks
1. `test/m18-document-access.e2e-spec.ts` covering each row, listing, upload labels and attaching. Watch it fail.
2. Access rule, controller routes, attach checks (receiving, tax filing, leave, checklists, audits, food safety, corrective actions, discipline, guides).
3. Receiving evidence link downloads with sign-in. Full tests.
