# Contract templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native, self-review).

**Goal:** Offers use uploaded Word templates, filled and delivered as PDF.
**Spec:** `business-hub/docs/superpowers/specs/2026-11-27-contract-templates-design.md`
**Architecture:** `ContractTemplate` rows with files in `StorageAdapter`; pure fill module; `PdfConverter` adapter (LibreOffice), faked in tests.
**Tech Stack:** NestJS, Prisma, docxtemplater + pizzip, LibreOffice.

## Global Constraints
`.docx` only, 5 MB; markers exactly as the spec lists; no commits unless asked; e2e only on `business_hub_test`.

## Review Focus
Marker typed in a header or footer; non-Word file renamed `.docx`; template linking to an outside address; converter failure leaves no half-made offer; Arabic renders in the PDF.

## Tasks
1. `onboarding/contract-template.ts`: `MARKERS`, `readTemplate(buf): string[]` (throws 400 on non-docx, unknown markers, external non-hyperlink links), `fillTemplate(buf, values): Buffer`. `onboarding/pdf.ts`: `PdfConverter.convert(docx): Promise<Buffer>`, `SofficeConverter`.
2. Model + migration; `GET/POST /contract-templates`, `PATCH /contract-templates/:id`, `PUT /contract-templates/:id/file`, `GET /contract-templates/:id/download` (upload/change: HR, OWNER; read: also FINANCE).
3. `OfferDto.templateId`; render before the offer is saved; `GET /offers/:id/contract`; public `GET /apply/status/:token/offer/contract`. Test `test/m17-contract-templates.e2e-spec.ts`.
4. Screens: Onboarding "Contract templates" tab and offer "Contract" download; template picker on the offer form; careers PDF link.
5. Dockerfile: LibreOffice and fonts. Verify a real Arabic conversion in the container; full tests; deploy.
