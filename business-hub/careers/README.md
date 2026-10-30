# Careers (candidate app)
Mobile-first public app for applicants. No login: tokens in the URL are the credential.
- `npm install && npm run dev` (port 5176; `VITE_API_URL` defaults to http://localhost:3000).
- `/:tenant` lists open vacancies; `/:tenant/:code` shows the screening criteria and the application form.
- `/status/:token` shows progress, offer and signature, documents, one-time personal details, appeal, withdraw and erase.
- `/interview/:token` shows the notice first, needs explicit consent, offers a human interviewer at every step.
- English/Arabic (RTL). No field about age, gender, nationality, religion, marital status or photo exists, by design.
- Audio recording is optional and needs its own consent.
