# Session indicators and connection recovery

Captured on macOS on 5 November 2026 in the running LegalWork Electron development app, using the actual local service and an existing conversation. These are native screenshots, without simulated service responses or sample chat history.

- [Reconnect inside the chat tab](reconnect-in-chat.png): the notice appears below the tab strip; both existing chat tabs and the loaded conversation remain visible. The footer is removed and Settings is above the account button in the left rail.
- [Expanded error details](reconnect-details.png): **Show details** reveals the actual desktop error; **Try again** starts another connection attempt.
- [Settings navigation](settings-navigation.png): the relocated Settings button opens the normal Settings overview and remains available there.
- [Successful retry](recovered-chat.png): **Try again** restores the composer and clears the notice, retaining both existing tabs and their conversation.

To verify the failure, the development app's engine resource symlink was temporarily removed and its real local service was stopped. Returning from Settings to the loaded chat triggered an actual reconnect failure. The symlink was restored immediately after the error appeared, then **Try again** successfully reconnected to the real runtime. The temporary fault and development launcher are not part of this change.
