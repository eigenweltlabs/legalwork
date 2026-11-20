import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "@/i18n";
import { formatCalendarDay } from "../calendar/calendar-format";

type Booking = { id: string; date: string; description: string; worker?: string; details?: string };

// A save started on an earlier visit may finish after navigating back to the same day.
export function useBookingReceipt(day: string, open: (date: string, worker?: string) => void, visible = true) {
  const visit = useMemo(() => ({}), [day, visible]);
  const active = useRef<object | null>(visit);
  const [list, setList] = useState<{ visit: object; items: Booking[] }>({ visit, items: [] });
  useLayoutEffect(() => {
    active.current = visit;
    setList({ visit, items: [] });
    return () => { active.current = null; };
  }, [visit]);
  const bookings = list.visit === visit && visible ? list.items : [];
  function showBooking(item: Booking) {
    if (active.current !== visit || !visible) return;
    setList(previous => ({ visit, items: [...previous.items.filter(existing => existing.id !== item.id), item] }));
  }
  function receipt(render: (booking: Booking, index: number) => ReactNode, dateFor: (booking: Booking) => string) {
    return bookings.length > 0 && <section className="time-booking-receipt" aria-label={t("timesheets.sheet.just_created")}>
      <strong>{t("timesheets.sheet.just_created")}</strong>
      {bookings.map((item, index) => {
        const date = dateFor(item);
        return (
          <div key={item.id} className="time-created-entry">
            {render(item, index) ?? <div>{item.description}{item.details && <small>{item.details}</small>}</div>}
            {date !== day && <button type="button" className="time-created-date" onClick={() => open(date, item.worker)}>
              {t("timesheets.sheet.view_date", { date: formatCalendarDay(date, { day: "numeric", month: "long", year: "numeric" }) })}
            </button>}
          </div>
        );
      })}
    </section>;
  }
  return { showBooking, bookings, receipt };
}
