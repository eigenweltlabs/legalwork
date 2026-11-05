import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

type CalendarVisibility = {
  hidden: Record<string, string[]>;
  setVisible: (view: string, calendar: string, visible: boolean) => void;
};

// Only view preferences are persisted, never connected event contents.
export const createCalendarVisibility = (storage: () => StateStorage = () => window.localStorage) => create<CalendarVisibility>()(persist(set => ({
  hidden: {},
  setVisible: (view, calendar, visible) => set(state => ({ hidden: { ...state.hidden,
    [view]: visible ? (state.hidden[view] ?? []).filter(key => key !== calendar) : [...new Set([...(state.hidden[view] ?? []), calendar])],
  } })),
}), { name: "legalwork.calendar-visibility.v1", storage: createJSONStorage(storage) }));

export const useCalendarVisibility = createCalendarVisibility();
