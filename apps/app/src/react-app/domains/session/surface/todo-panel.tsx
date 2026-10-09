import { useState } from "react";
import { Check, Minimize2 } from "lucide-react";
import type { TodoItem } from "@/app/types";
import { t } from "@/i18n";

export function hasUnfinishedTodos(todos: TodoItem[]) {
  return todos.some((todo) => todo.content.trim() && todo.status !== "completed" && todo.status !== "cancelled");
}

export function TodoPanel(props: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const todos = props.todos.filter((todo) => todo.content.trim());
  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  const progressLabel = t("session.todo_progress_label");
  const label = expanded ? progressLabel : `${progressLabel} · ${completedTodos}/${todos.length}`;

  if (!hasUnfinishedTodos(todos)) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
        <button
          aria-expanded={expanded}
          type="button"
          className="flex w-full items-center justify-between px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50"
          onClick={() => setExpanded((current) => !current)}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-11">{label}</span>
          </div>
          <Minimize2 size={12} className={`text-gray-8 transition-transform ${expanded ? "" : "rotate-180"}`} />
        </button>
        {expanded ? (
          <div className="max-h-60 space-y-2.5 overflow-auto border-t border-dls-border px-4 pb-3">
            {todos.map((todo, index) => {
              const done = todo.status === "completed";
              const cancelled = todo.status === "cancelled";
              const active = todo.status === "in_progress";
              return (
                <div key={index} className="flex items-start gap-2.5 pt-2.5 first:pt-2.5">
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <div
                      className={`flex size-4.5 items-center justify-center rounded-full border ${
                        done
                          ? "border-green-6 bg-green-2 text-green-11"
                          : active
                            ? "border-amber-6 bg-amber-2 text-amber-11"
                            : cancelled
                              ? "border-gray-6 bg-gray-2 text-gray-8"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                      }`}
                    >
                      {done ? <Check size={10} /> : active ? <span className="size-1.5 rounded-full bg-amber-9" /> : null}
                    </div>
                  </div>
                  <div className={`flex-1 text-sm leading-relaxed ${cancelled ? "text-gray-9 line-through" : "text-gray-12"}`}>
                    <span className="mr-1.5 text-gray-9">{index + 1}.</span>
                    {todo.content}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
    </div>
  );
}
