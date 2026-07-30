# Artist Intake State Machine

**Implementation:** `lib/intake-state-machine.js`  
**States:** 21  
**Version:** intake-state-machine-v1

---

## States

| State | Description |
|-------|-------------|
| `INVITED` | Artist has received an intake invitation but has not yet started |
| `IDENTITY_PENDING` | Identity questionnaire sent; awaiting artist completion |
| `IDENTITY_CONFIRMED` | Identity and authority questionnaire accepted |
| `ENGAGEMENT_PENDING` | Engagement agreement ready; awaiting signature |
| `ENGAGEMENT_SENT` | Engagement agreement envelope sent to artist |
| `ENGAGEMENT_SIGNED` | Engagement agreement fully executed |
| `LOA_PENDING` | Limited Letter of Authorization ready; awaiting signature |
| `LOA_SENT` | LOA envelope sent to artist |
| `LOA_SIGNED` | LOA fully executed |
| `EXPORT_GUIDANCE_PENDING` | Artist directed to export center; awaiting document submission |
| `DOCUMENTS_PARTIAL` | Some documents received; more expected |
| `DOCUMENTS_COMPLETE` | All required documents submitted; validation pending |
| `DOCUMENTS_VALIDATING` | Operator/system is validating received documents |
| `DOCUMENTS_NEED_CORRECTION` | One or more documents rejected; replacement required |
| `OWNERSHIP_REVIEW` | Master ownership evidence under review |
| `AUTHORIZATION_REVIEW` | LOA scope or authorization record under review |
| `AUDIT_READY` | All mandatory requirements met; ready for audit pipeline handoff |
| `AUDIT_IN_PROGRESS` | Neighboring-rights audit actively running |
| `CLIENT_ACTION_REQUIRED` | Artist action needed to unblock progress |
| `CLOSED` | Audit complete (terminal) |
| `WITHDRAWN` | Artist withdrew or engagement expired (terminal) |

---

## Legal Transitions

```
INVITED                  → IDENTITY_PENDING, WITHDRAWN
IDENTITY_PENDING         → IDENTITY_CONFIRMED, WITHDRAWN, CLIENT_ACTION_REQUIRED
IDENTITY_CONFIRMED       → ENGAGEMENT_PENDING, WITHDRAWN
ENGAGEMENT_PENDING       → ENGAGEMENT_SENT, WITHDRAWN
ENGAGEMENT_SENT          → ENGAGEMENT_SIGNED, ENGAGEMENT_PENDING (resend/expired), WITHDRAWN
ENGAGEMENT_SIGNED        → LOA_PENDING, WITHDRAWN
LOA_PENDING              → LOA_SENT, WITHDRAWN
LOA_SENT                 → LOA_SIGNED, LOA_PENDING (resend/expired), WITHDRAWN
LOA_SIGNED               → EXPORT_GUIDANCE_PENDING, WITHDRAWN
EXPORT_GUIDANCE_PENDING  → DOCUMENTS_PARTIAL, WITHDRAWN
DOCUMENTS_PARTIAL        → DOCUMENTS_PARTIAL (additional upload), DOCUMENTS_COMPLETE, CLIENT_ACTION_REQUIRED, WITHDRAWN
DOCUMENTS_COMPLETE       → DOCUMENTS_VALIDATING
DOCUMENTS_VALIDATING     → DOCUMENTS_NEED_CORRECTION, OWNERSHIP_REVIEW, AUTHORIZATION_REVIEW, AUDIT_READY
DOCUMENTS_NEED_CORRECTION→ DOCUMENTS_PARTIAL, WITHDRAWN
OWNERSHIP_REVIEW         → AUTHORIZATION_REVIEW, DOCUMENTS_NEED_CORRECTION, AUDIT_READY, CLIENT_ACTION_REQUIRED
AUTHORIZATION_REVIEW     → AUDIT_READY, DOCUMENTS_NEED_CORRECTION, CLIENT_ACTION_REQUIRED
AUDIT_READY              → AUDIT_IN_PROGRESS, WITHDRAWN
AUDIT_IN_PROGRESS        → CLIENT_ACTION_REQUIRED, CLOSED
CLIENT_ACTION_REQUIRED   → DOCUMENTS_PARTIAL, OWNERSHIP_REVIEW, AUTHORIZATION_REVIEW, WITHDRAWN
CLOSED                   → CLOSED (idempotent terminal)
WITHDRAWN                → WITHDRAWN (idempotent terminal)
```

---

## Transition Record Fields

Every state transition records:

| Field | Description |
|-------|-------------|
| `actor` | Who caused the transition (user email, "system", "operator") |
| `timestamp` | ISO-8601 UTC timestamp |
| `prior_state` | Previous state |
| `new_state` | New state |
| `trigger` | Machine-readable event code |
| `evidence_ref` | Optional document ID or reference |
| `auth_scope` | Optional authorization scope applied |
| `correlation_id` | Tracing ID linking related events |
| `reason` | Human-readable explanation |

---

## Idempotency

- Terminal states (`CLOSED`, `WITHDRAWN`) are idempotent — transitioning to the same terminal state returns no record and does not create a duplicate.
- `DOCUMENTS_PARTIAL→DOCUMENTS_PARTIAL` is a valid self-loop (each additional upload creates a transition record).
- All other same-state transitions are rejected as invalid.

---

## Usage Example

```javascript
const { transition } = require('./lib/intake-state-machine');

const result = transition('INVITED', 'IDENTITY_PENDING', {
  actor: 'system',
  trigger: 'intake_initiated',
  correlationId: 'corr-12345',
  reason: 'Artist clicked intake link',
});
// result.state → 'IDENTITY_PENDING'
// result.record → { actor, timestamp, prior_state, new_state, trigger, ... }
// Caller is responsible for persisting result.record to intake_transitions_v1
```
