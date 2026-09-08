# MoneyKernel dashboard

The owner-selected direction is a calm, light product dashboard, with a corresponding dark theme. Operate mode: make account state and the next required decision readable at a glance.

Use Radix UI for accessible section navigation and the workspace menu, Lucide for consistent icons, and locally hosted DM Sans. Neutral black, white and gray surfaces use Binance gold sparingly for brand and action emphasis, with dark ink on gold fills and an accessible darker gold for small text in light mode. Green is reserved for verified success states. Red and amber indicate actual action risks and unresolved state, not decoration. Dark mode preserves exactly the same hierarchy and contrast.

Navigation: Overview, Approvals, Agents, Activity, System. Overview shows three cash figures, a compact attention list, holdings and recent activity. Administration, full audit payloads and integration diagnostics have dedicated destinations. Stop and unknown-state warnings remain available across every destination; the mode label always states the execution environment.

Activity and decision receipts lead with plain-language events, requested versus policy-adjusted amounts, the decision reason and execution status. Ordered checks, hashes, identifiers and raw JSON remain available in collapsed technical-evidence sections and JSON exports.

At narrow widths navigation becomes a scrollable horizontal strip, the header wraps deliberately, and content becomes one column. Forms and exact order details remain usable without page overflow. Keep advanced agent fields behind labelled disclosures. No decorative charts, fabricated profits, glowing borders or grids of status pills.

Theme controls are available before and after sign-in. Persist only the theme name in localStorage; storage failure must not prevent rendering. Motion is limited to focus, hover and short menu transitions, with reduced-motion support. Preserve native dialogs for protected approval and destructive-action confirmation.
