# 8. Risk Register

  -----------------------------------------------------------------------
  Risk                    Impact                  Mitigation
  ----------------------- ----------------------- -----------------------
  Gnani endpoint,         Voice path blocks       Day-1 smoke test; text
  credentials, or quota                           fallback; mock mode for
  unavailable                                     development/demo only

  Speech accuracy varies  Wrong room              Editable transcript;
  by dialect/accent       counts/dimensions       confirmation for
                                                  numbers; test priority
                                                  languages; no universal
                                                  coverage claims

  Image model changes     Misleading concepts     SVG labels for floor
  geometry/reference                              plans; preserve
  details                                         features in prompts;
                                                  concept disclaimers;
                                                  customer-approved brief

  Invalid model output    Broken plan or quote    Strict JSON schema, Zod
                                                  validation, error
                                                  state; model never
                                                  controls prices

  Model                   Cost spike or failed    Runtime model
  price/availability      generation              discovery; caps;
  changes                                         fallback; usage/cost
                                                  logging

  Fraudulent/mistaken     Unpaid work released    Human checks receiving
  payment evidence                                account; server state
                                                  machine; audit log

  Four-day schedule       Incomplete vertical     Prioritize one complete
  overrun                 slice                   secure journey; defer
                                                  non-core features

  Private photos/payment  Privacy/trust impact    Private buckets, RLS,
  proof exposed                                   signed URLs, short
                                                  expiry, authorization,
                                                  retention limits, audit

  Duplicate generation    Duplicate cost          Idempotency key/job
  retries                                         record, bounded retry,
                                                  job status checks

  False impression of     Safety/legal risk       Persistent concept-only
  professional compliance                         disclaimers; qualified
                                                  professional review; no
                                                  unsupported compliance
                                                  claims
  -----------------------------------------------------------------------

------------------------------------------------------------------------
