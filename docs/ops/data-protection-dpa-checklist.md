# Data-protection (DPA) checklist — Kenya Data Protection Act, 2019

**Status: requires DPO/Legal sign-off.** Engineering can evidence the technical controls; the
lawful-basis, retention-period, and processor-agreement items need the Data Protection Officer /
Legal. Tick only after their review. This is a go-live gate, not legal advice.

## Governance

- [ ] Registered as a **data controller** with the ODPC (Office of the Data Protection
      Commissioner) if thresholds require it.
- [ ] A Data Protection Officer / responsible owner is named.
- [ ] A **Data Protection Impact Assessment (DPIA)** completed for the order/payment/location
      processing.

## Data inventory & lawful basis

- [ ] Personal data mapped. Known PII in the platform: customer **phone (`phone_e164`)**, name,
      **delivery addresses / geolocation**, rider **KYC/onboarding** data and proof images,
      order history, payment references (M-Pesa). Confirm the full set.
- [ ] A **lawful basis** recorded for each purpose (contract performance for order fulfilment;
      consent for marketing/notifications; legal obligation for financial records).
- [ ] Privacy notice published and shown at collection (apps + dashboards).
- [ ] **Data minimisation**: only data needed for delivery/payments is collected; dev/test uses
      **synthetic data only** (CLAUDE.md).

## Retention & deletion

- [ ] Retention schedule defined per data class. **Financial/ledger/settlement/payout/audit
      records** keep **extended statutory/tax retention** (confirm exact period with Finance/Legal;
      DR doc §6) — these are **not** deleted on routine erasure requests.
- [ ] Backups/PITR retention aligns with the schedule (DR doc §6); object-storage lifecycle set
      for KYC/images/proofs.

## Data-subject rights

- [ ] Process to handle **access, rectification, erasure, objection, portability** within
      statutory timelines.
- [ ] Erasure honours the financial-records carve-out (anonymise/retain-restricted rather than
      hard-delete where law requires retention).

## Processors & transfers

- [ ] Data-processing agreements with processors: **Safaricom (M-Pesa/Daraja)**, SMS provider,
      maps provider, hosting/managed-DB/Redis, object storage.
- [ ] Any **cross-border transfer** assessed and safeguarded (data residency / adequacy).

## Security of processing

- [ ] Encryption **at rest** (storage-level) and **in transit** (TLS) — cross-ref
      `security-review-checklist.md`.
- [ ] Access controls, audit logging, and least privilege in place (see security checklist).

## Breach response

- [ ] Documented breach-detection + notification procedure (ODPC + affected subjects) within the
      statutory window; on-call knows the trigger and owner.

---

**Sign-off:** DPO / Legal __________________ date __________ result: PASS / FAIL / CONDITIONAL
