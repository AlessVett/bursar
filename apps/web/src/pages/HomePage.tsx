import { localTimeOfDay, toLocalDate } from "@bursar/shared";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../components/ui";
import { useFormatters } from "../lib/format";

/** Morning before 12:00, afternoon before 18:00, evening otherwise (owner's local time). */
export function greetingKey(
  timeOfDay: string,
): "home.greeting.morning" | "home.greeting.afternoon" | "home.greeting.evening" {
  const hour = Number.parseInt(timeOfDay.slice(0, 2), 10);
  if (hour >= 5 && hour < 12) return "home.greeting.morning";
  if (hour >= 12 && hour < 18) return "home.greeting.afternoon";
  return "home.greeting.evening";
}

/** Home in Task 4: the greeting with the local date. Task 17 adds the summary, KPIs and alerts. */
export function HomePage() {
  const { t } = useTranslation();
  const format = useFormatters();
  const now = format.now();
  const today = toLocalDate(now, format.timeZone);
  return (
    <PageHeader
      title={t(greetingKey(localTimeOfDay(now, format.timeZone)))}
      subtitle={format.localDate(today, "long")}
    />
  );
}
