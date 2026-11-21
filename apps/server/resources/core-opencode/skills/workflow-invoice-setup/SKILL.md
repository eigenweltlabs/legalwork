---
name: workflow-invoice-setup
description: Prepare and revise an editable Word invoice template with the user in their chosen workspace.
---
Open the DOCX attached to this conversation. Work on that workspace copy. Use the document editing tools to inspect the existing layout, preserve its typography, letterhead, margins, images, styles and language, and make the requested visual changes. Use synthetic sample information only. Keep the conversation open for further revisions.

Insert plain Word text fields with these Jinja2 expressions. Required fields are `{{ invoice_number }}`, `{{ invoice_date }}`, `{{ client_name }}`, `{{ client_address }}` and `{{ total }}`. Optional fields are `title`, `letterhead`, `footer`, `currency`, `description_label`, `amount_label` and `total_label`, enclosed in double braces.

Use one repeating Word table row. Put `{% for line in lines %}` before its first field and `{% endfor %}` after its last field, inside that same row. Use `{{ line.description }}` and `{{ line.amount }}`. Use `{{ line.hours_label }}` alongside the narrative for optional recorded and billable hours; the renderer supplies localized labels and removes the entire suffix when hours are hidden. Additional fields are `line.date`, `line.hours` and `line.billable_hours`. Keep each expression within one paragraph. Use embedded static images. Use the approved field names exactly.

Save the editable DOCX at the attached path. Tell the user to load the workspace copy under Billing Settings, preview its layout and save the template revision. Further requests should edit that same copy. Amounts, approval, sequence numbers and invoice issuance belong to the billing workflow.
