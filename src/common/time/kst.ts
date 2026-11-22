const KST = 'Asia/Seoul';

export interface TimeRange {
  start: Date;
  end: Date;
}

const toDate = (zdt: Temporal.ZonedDateTime): Date => new Date(zdt.epochMilliseconds);

const rangeOf = (start: Temporal.PlainDate, end: Temporal.PlainDate): TimeRange => ({
  start: toDate(start.toZonedDateTime(KST)),
  end: toDate(end.toZonedDateTime(KST)),
});

export function kstDate(at: Date = new Date()): string {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(KST)
    .toPlainDate()
    .toString();
}

/** KST 시각 HH:mm */
export function kstTime(at: Date = new Date()): string {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(KST)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' });
}

export function kstDayRange(date: string): TimeRange {
  const day = Temporal.PlainDate.from(date);
  return rangeOf(day, day.add({ days: 1 }));
}

export function kstWeekRange(date: string): TimeRange {
  const day = Temporal.PlainDate.from(date);
  const monday = day.subtract({ days: day.dayOfWeek - 1 });
  return rangeOf(monday, monday.add({ weeks: 1 }));
}

export function kstMonthRange(date: string): TimeRange {
  const first = Temporal.PlainDate.from(date).with({ day: 1 });
  return rangeOf(first, first.add({ months: 1 }));
}
