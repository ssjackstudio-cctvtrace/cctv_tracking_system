// Opening hours of the shop (JackStudio @ Aeon Bukit Tinggi):
// 10:00 AM – 10:30 PM on Friday and Saturday, 10:00 AM – 10:00 PM other days.
export const OPEN_MINUTES = 10 * 60
export const closeMinutes = (day: Date) => (day.getDay() === 5 || day.getDay() === 6 ? 22 * 60 + 30 : 22 * 60)

// True once the shop has closed for the day of `at` (after closing time)
export const closedForTheDay = (at: Date) => at.getHours() * 60 + at.getMinutes() >= closeMinutes(at)
