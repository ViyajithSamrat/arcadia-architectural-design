# 11. Decision Log and Open Questions

The PDF intentionally leaves several business/provider details
configurable. Resolve these during Day 1 and record the decision in the
repository README or an ADR.

  -----------------------------------------------------------------------
  Decision                Status                  Required action
  ----------------------- ----------------------- -----------------------
  Actual Gnani            Not specified in source Verify against
  endpoints/auth scheme                           account/product docs
  and credentials                                 and run isolated smoke
                                                  tests

  Initial supported voice Not specified; choose a Product owner chooses
  languages               small agreed set        priority languages;
                                                  test actual recordings

  OpenRouter text/image   Configurable            Verify current model
  model IDs and fallback                          availability,
                                                  reference-image
                                                  support, pricing,
                                                  limits

  Actual commercial       Not specified           Enter approved rates or
  pricing and currency                            clearly labelled
                                                  demo-only placeholders

  Official UPI/bank       Not specified           Configure
  instructions                                    business-approved
                                                  receiving details
                                                  server-side

  Tax, discount,          Not specified           Business
  refund/cancellation                             owner/accountant review
  language                                        before real payments

  Upload/audio/image      Not specified           Choose conservative
  limits and signed URL                           values, configure
  expiry                                          centrally, test limits

  Admin role assignment   Must be                 Define secure role
  mechanism               server-controlled;      source and test every
                          exact mechanism not     privileged route
                          specified

  Data-retention periods  Policy required;        Set explicit
                          durations not specified retention/deletion
                                                  rules and obtain
                                                  required consent

  Final database enum     Not fully specified     Keep app/database state
  names and migration                             names aligned; document
  approach                                        migrations

  Production              Explicitly out of scope Schedule separate
  readiness/compliance    for four-day PoC        security, professional,
                                                  legal, and operational
                                                  review
  -----------------------------------------------------------------------

------------------------------------------------------------------------
