# Session indicators and connection recovery

Captured on macOS on 5 November 2026 in the running LegalWork Electron development app, using the actual local service, an existing conversation, and real verification tasks. These are native screenshots, without simulated service responses or sample chat history.

- [Chat tab indicators](chat-tab-indicators.png): an idle tab, an amber dot for a real unanswered question, a blue dot for a completed background reply, and a spinner for a running task. The sidebar shows the same states; Settings sits above the account button and the footer is absent.
- [Session overview indicators](session-overview-indicators.png): the same running, unread, and waiting states appear on conversation rows in place of the old generic Running badge.
- [Waiting chat](waiting-chat.png): the active tab's amber dot corresponds to an actual unanswered English/German question in the conversation.
- [Reconnect inside the chat tab](reconnect-in-chat.png): the notice appears below the tab strip; both existing chat tabs and the loaded conversation remain visible. The footer is removed and Settings is above the account button in the left rail.
- [Expanded error details](reconnect-details.png): **Show details** reveals the actual desktop error; **Try again** starts another connection attempt.
- [Settings navigation](settings-navigation.png): the relocated Settings button opens the normal Settings overview and remains available there.
- [Successful retry](recovered-chat.png): **Try again** restores the composer and clears the notice, retaining both existing tabs and their conversation.

To verify the failure, the development app's engine resource symlink was temporarily removed and its real local service was stopped. Returning from Settings to the loaded chat triggered an actual reconnect failure. The symlink was restored immediately after the error appeared, then **Try again** successfully reconnected to the real runtime. The temporary fault and development launcher are not part of this change.

For the indicator captures, one real chat requested a question and waited for an answer, a second produced a short reply while in the background, and a third ran `sleep 45` before replying. The running task completed normally and the question was answered after capture. No project files were read or modified by those verification tasks.
