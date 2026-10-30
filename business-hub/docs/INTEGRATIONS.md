# Integration feasibility matrix

All external integrations are adapters behind an abstract class, selected by `INTEGRATION_MODE` (default `stub`) with per-adapter overrides. Asking for a live adapter that does not exist fails at startup (`requireStub`); nothing silently pretends. Retry, backoff and dead-letter go through one BullMQ `IntegrationJob` mechanism.

| Adapter | Purpose | State today | To go live |
|---|---|---|---|
| `EInvoiceAdapter` | JoFotara e-invoicing | Stub: accepts and returns a fake reference | Confirmed API access and credentials; map `Invoice` to the official payload |
| `TaxFilingAdapter` | Tax authority return submission | Stub: no submission. A guided manual package is produced and the filing tracked | Official submission API, if one exists for the taxpayer |
| `SscAdapter` | Social security registration / termination | Stub: `submit: false`. HR submits manually and records the reference | Verified integration and legal authorization |
| `PaymentGatewayAdapter` | Online order payment (eFAWATEERcom-style) | Stub | Provider contract |
| `AggregatorAdapter` | Talabat / Careem orders and menus | Stub with a webhook intake (`/aggregators/webhook/:tenant/:connectionId`) | Partner API access per aggregator |
| `PosTerminalAdapter` | Card terminal | Stub | Terminal vendor SDK |
| `DocumentProcessingAdapter` | OCR / QR for supplier invoices | Stub reads JSON fixtures; anything else routes to a human | OCR provider |
| `LlmAdapter` | Interview scoring (advice only) | Rule-based stub; OpenRouter adapter implemented but not tested against the live API | `OPENROUTER_API_KEY`, `LLM_MODE=openrouter` |
| `StorageAdapter` | Documents | Local disk (`STORAGE_DIR`) | S3-compatible implementation |
| `NotificationChannelAdapter` / `CustomerNotificationAdapter` / candidate notifier | In-app, SMS, WhatsApp, email | In-app only; others stubbed | Channel providers |

The brief does not establish official API access for JoFotara, SSC, or the aggregators. Treat every "go live" cell as needing external confirmation first.
