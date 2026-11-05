# Scheduled tasks

Open in LegalWork: [Scheduled](legalwork://app/scheduled).

A scheduled task sends instructions to the assistant at a chosen time or on a recurring schedule. It differs from a task's due date and a calendar reminder. This page applies when **Scheduled** is available in navigation.

## Create a schedule

You can also ask the Assistant to check something later or set up a recurring task. It acknowledges once, then shows a task card when the schedule is saved. Use **Open** on that card to inspect or change the schedule. The result arrives when the task runs; a failed save or a needed clarification is reported immediately.

1. Open **Scheduled** and choose **New scheduled task**, or select a starter and edit it.
2. Choose the local project that owns the task. Set **Project access** to **This project only** or **All projects** according to the work. Global recordings without a project are also available within the supported scheduled-run scope.
3. Enter a name and clear instructions, including the expected output and which sources to use. For example: "Each weekday, summarize open tasks and upcoming deadlines for this project, with links to the source records."
4. Select an available model. Choose **Once**, **Interval**, **Daily**, **Weekdays**, **Weekly**, or **Custom**. Set the start/run time and time zone, then verify the **Next run** preview. Custom schedules expose an advanced recurrence rule.
5. Under **Advanced**, choose whether to use a selected chat, reuse the same chat across runs or create a new chat each time. Choose whether its chat should be pinned.
6. Save and verify that the task is active with the intended next run.

Changing a chat model elsewhere does not necessarily update the saved scheduled task. Edit the schedule's own settings when its model or instructions need to change. A reusable [workflow](skills-workflows.md) can be named in the instructions, but saving a workflow alone creates no schedule.

## When it runs

These schedules run on this computer while LegalWork is open and the computer is awake. They are not hosted jobs that keep running after the computer shuts down. Files, providers and required connections must be available when the run starts.

After reopening, due work can run when the runtime becomes available. Missed repeated occurrences coalesce into one pending run rather than replaying every missed interval. A busy selected chat can delay delivery. Review the actual run time in history instead of treating the planned time as proof of execution.

## Inspect, pause and delete

Open a schedule to see its instructions, project/access scope, next run and run history. Use **Open chat** to inspect what happened. A sent run means the instructions were delivered to a chat; it does not certify that the assistant completed the requested work. If delivery is unconfirmed, inspect that chat before manually starting the same work again.

Use **Pause** to prevent future scheduled delivery and **Resume** when ready. A completed one-time schedule needs a future time before another run. **Delete** removes the schedule and its run history; existing chats remain. Pausing or deleting a schedule is not a stop control for an assistant response already running in a chat.

Related: [Tasks](tasks-intake.md), [Calendar](calendar.md), [Workflows](skills-workflows.md), [Troubleshooting](troubleshooting.md).
