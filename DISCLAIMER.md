# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-dead-lead-recycling-nurture-re-entry-router**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes emails or sequence steps sent to the wrong people, contacts re-engaged against their wishes or against a legal or contractual restriction, damage to sender reputation or email deliverability, enrichment-provider charges, incorrect contact records or lead statuses, and business decisions taken on the basis of recycling reports.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, qualification rules and sample payloads are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Email-verification and job-title data from any enrichment provider can be wrong or out of date. HubSpot, sequence and enrichment APIs and their limits can change at any time.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot or enrichment credentials or set `HUBSPOT_WRITES_ENABLED`, `SEQUENCE_ENROLLMENT_ENABLED`, `NURTURE_ROUTING_ENABLED` or `ENRICHMENT_ENABLED` to `true`. Review every dry-run routing report, and have a person check the sequence content and the first enrollments before you let the router run on a schedule.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam and electronic-marketing laws (e.g. CAN-SPAM, PECR, CASL), and security policies of HubSpot, your enrichment provider, n8n and any connected services. That includes confirming a lawful basis and any required consent before re-contacting people, honouring unsubscribe, objection and do-not-contact requests, having a data-processing agreement for sending contact data to an enrichment provider, keeping routing reports and execution data private, and reviewing every automatically updated record and enrollment.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
