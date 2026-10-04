# Usage recovery UI evidence

Captured through CUA on 2026-10-04. All images use local fixture data; no card was charged and no member request was submitted. The personal-limit form and confirmation were checked again after merging the latest dev branch. The inline recovery card changed to **AI usage available** after returning to chat.

| View | Screenshot |
| --- | --- |
| Free / Sync / Plus-Pro plan comparison | [Plans](plans.jpg) |
| Increase personal monthly limit | [Form](personal-limit.jpg) |
| Saved and ready to continue | [Confirmation](personal-limit-confirmed.jpg) |
| Increase organization monthly limit | [Form](team-limit.jpg) |
| Enable extra usage | [Form](enable-extra-usage.jpg) |
| Credits received and usable | [Confirmation](credits-confirmed.jpg) |
| Seat upgrade confirmed and ready | [Confirmation](upgrade-confirmed.jpg) |

After removing the obsolete member editor, the own-seat upgrade was checked through price review, confirmation and return to chat. A simulated failed usage refresh kept the upgrade confirmation visible, offered Refresh, and then reported available usage without repeating the purchase.

The regular-member flow opens **Request more usage** directly. The real dedicated Electron app was exercised in prior sandbox tests with a depleted member allowance. Member requests, approvals and new ChatGPT OAuth consent still need final acceptance in a packaged alpha build. Full account/member management stays on the platform.
