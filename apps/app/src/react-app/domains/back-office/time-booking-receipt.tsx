import { useEffect, useState } from "react";
import { t } from "@/i18n";
import { formatCalendarDay } from "../calendar/calendar-format";

export function useBookingReceipt(day: string, dates: readonly string[], open: (date: string) => void) {
  const [booking, setBooking] = useState<{ date: string; description: string; view: string }>();
  const view = day + "/" + dates.length;
  useEffect(() => { setBooking(undefined); }, [view]);
  function showBooking(date: string, description: string) {
    if (!dates.includes(date)) setBooking({ date, description, view });
  }
  const receipt = booking?.view === view && (
    <div className="time-booking-receipt" role="status">
      <span>{t("timesheets.sheet.just_created", { description: booking.description })}</span>
      <button type="button" onClick={() => open(booking.date)}>{t("timesheets.sheet.view_date", {
        date: formatCalendarDay(booking.date, { day: "numeric", month: "long", year: "numeric" }),
      })}</button>
    </div>
  );
  return { showBooking, receipt };
}
